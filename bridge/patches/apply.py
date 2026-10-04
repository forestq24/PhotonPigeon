#!/usr/bin/env python3
"""Patch Corten's rustpush wrapper so iMessage app balloons pass through.

Upstream drops them in both directions: inbound messages expose no balloon URL,
and send_message hardcodes `app: None`. This adds balloon fields to
WrappedMessage (for plain messages and for session replies, which arrive as
"extension reactions") and a Client::send_balloon method.

Run it on a pristine lib.rs; scripts/setup.sh resets the file first.

Fail-closed: every anchor must match exactly once, or nothing is written.
Idempotent: a second run is a no-op.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
LIB = ROOT / ".build" / "corten" / "pkg" / "rustpushgo" / "src" / "lib.rs"
MARKER = "PhotonPigeon bridge patch"

FIELDS = """
    // PhotonPigeon bridge patch: iMessage app balloon (e.g. GamePigeon).
    pub app_bundle_id: Option<String>,
    pub app_name: Option<String>,
    pub app_adam_id: Option<u64>,
    pub balloon_url: Option<String>,
    pub balloon_session: Option<String>,
    pub balloon_caption: Option<String>,
    pub balloon_subcaption: Option<String>,
    pub balloon_ld_text: Option<String>,
    pub balloon_is_live: bool,
    pub balloon_icon: Option<Vec<u8>>,
"""

INITS = """        app_bundle_id: None,
        app_name: None,
        app_adam_id: None,
        balloon_url: None,
        balloon_session: None,
        balloon_caption: None,
        balloon_subcaption: None,
        balloon_ld_text: None,
        balloon_is_live: false,
        balloon_icon: None,
"""

INBOUND = """            // PhotonPigeon bridge patch: expose the app balloon.
            if let Some(ref app) = normal.app {
                w.app_bundle_id = Some(app.bundle_id.clone());
                w.app_name = Some(app.name.clone());
                w.app_adam_id = app.app_id;
                if let Some(ref balloon) = app.balloon {
                    w.balloon_url = Some(balloon.url.clone());
                    w.balloon_session = balloon.session.clone();
                    w.balloon_ld_text = balloon.ld_text.clone();
                    w.balloon_is_live = balloon.is_live;
                    w.balloon_icon = balloon.icon.clone();
                    if let Some(layout) = &balloon.layout {
                        let rustpush::BalloonLayout::TemplateLayout { caption, subcaption, .. } = layout;
                        w.balloon_caption = Some(caption.clone());
                        w.balloon_subcaption = Some(subcaption.clone());
                    }
                }
            }

"""

REACT_OLD = """                ReactMessageType::Extension { .. } => {
                    // Extension reactions (stickers etc.) — mark as tapback
                    w.tapback_type = Some(7);
                }
"""

REACT_NEW = """                ReactMessageType::Extension { spec, .. } => {
                    // Extension reactions (stickers etc.) — mark as tapback
                    w.tapback_type = Some(7);
                    // PhotonPigeon bridge patch: a card sent as a reply inside an app
                    // session (every GamePigeon move after the first) arrives here.
                    w.app_bundle_id = Some(spec.bundle_id.clone());
                    w.app_name = Some(spec.name.clone());
                    w.app_adam_id = spec.app_id;
                    if let Some(ref balloon) = spec.balloon {
                        w.balloon_url = Some(balloon.url.clone());
                        w.balloon_session = balloon.session.clone();
                        w.balloon_ld_text = balloon.ld_text.clone();
                        w.balloon_is_live = balloon.is_live;
                        w.balloon_icon = balloon.icon.clone();
                        if let Some(layout) = &balloon.layout {
                            let rustpush::BalloonLayout::TemplateLayout { caption, subcaption, .. } = layout;
                            w.balloon_caption = Some(caption.clone());
                            w.balloon_subcaption = Some(subcaption.clone());
                        }
                    }
                }
"""

SEND = """
// ---- PhotonPigeon bridge patch: send an iMessage app balloon ----
impl Client {
    #[allow(clippy::too_many_arguments)]
    pub async fn send_balloon(
        &self,
        conversation: WrappedConversation,
        handle: String,
        bundle_id: String,
        app_name: String,
        adam_id: Option<u64>,
        url: String,
        session: Option<String>,
        caption: Option<String>,
        subcaption: Option<String>,
        ld_text: Option<String>,
        is_live: bool,
        icon: Option<Vec<u8>>,
        breadcrumb: Option<String>,
        reply_to: Option<String>,
    ) -> Result<String, WrappedError> {
        let conv: rustpush::ConversationData = (&conversation).into();
        let layout = rustpush::BalloonLayout::TemplateLayout {
            image_subtitle: String::new(),
            image_title: String::new(),
            caption: caption.unwrap_or_default(),
            secondary_subcaption: String::new(),
            tertiary_subcaption: String::new(),
            subcaption: subcaption.unwrap_or_default(),
            class: rustpush::NSDictionaryClass::NSDictionary,
        };
        let parts = rustpush::MessageParts(vec![rustpush::IndexedMessagePart {
            part: rustpush::MessagePart::Object(breadcrumb.unwrap_or_default()),
            idx: None,
            ext: None,
        }]);
        let app = rustpush::ExtensionApp {
            name: app_name,
            app_id: adam_id,
            bundle_id,
            balloon: Some(rustpush::Balloon {
                url,
                session,
                layout: Some(layout),
                ld_text,
                is_live,
                icon,
            }),
        };
        // Real clients send every card after the first in a session as an
        // "extension reaction" to the previous one. A plain message also works.
        let message = match reply_to {
            Some(to_uuid) => rustpush::Message::React(rustpush::ReactMessage {
                to_uuid,
                to_part: Some(0),
                reaction: rustpush::ReactMessageType::Extension { spec: app, body: parts, is_meta: false },
                to_text: String::new(),
                embedded_profile: None,
            }),
            None => {
                let mut normal = rustpush::NormalMessage::new(String::new(), rustpush::MessageType::IMessage);
                normal.parts = parts;
                normal.app = Some(app);
                rustpush::Message::Message(normal)
            }
        };
        let mut msg = rustpush::MessageInst::new(conv, &handle, message);
        self.send_with_flap_retry(&mut msg).await
            .map_err(|e| WrappedError::GenericError { msg: format!("Failed to send balloon: {}", e) })?;
        Ok(msg.id.clone())
    }
}
"""

# (label, anchor, text, insert "after" or "before" the anchor)
EDITS = [
    ("WrappedMessage fields",
     "pub struct WrappedMessage {\n    pub uuid: String,\n", FIELDS, "after"),
    ("WrappedMessage initializers",
     "    let mut w = WrappedMessage {\n        uuid: msg.id.clone(),\n", INITS, "after"),
    ("inbound balloon mapping",
     "            // Sticker data from extension balloons (icon field)\n", INBOUND, "before"),
    ("inbound session-reply balloon mapping", REACT_OLD, REACT_NEW, "replace"),
]


def main() -> int:
    if not LIB.is_file():
        print(f"error: {LIB} not found; run scripts/setup.sh first", file=sys.stderr)
        return 1
    src = LIB.read_text()
    if MARKER in src:
        print("balloon patch already applied")
        return 0
    for label, anchor, text, where in EDITS:
        count = src.count(anchor)
        if count != 1:
            print(f"error: anchor for '{label}' matched {count} times (expected 1); upstream changed", file=sys.stderr)
            return 1
        replacement = {"after": anchor + text, "before": text + anchor, "replace": text}[where]
        src = src.replace(anchor, replacement)
        print(f"  patch {label}")
    src += SEND
    print("  patch Client::send_balloon")
    LIB.write_text(src)
    return 0


if __name__ == "__main__":
    sys.exit(main())
