import { Spectrum } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";
// Spectrum bridges a single agent loop to many messaging interfaces.
// Each provider in `providers` adds an interface (terminal TUI, iMessage, …).
// Docs: https://photon.codes/docs/spectrum-ts
const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers: [
    // imessage
    imessage.config(),
  ],
});

// `app.messages` is an async iterable. Each tick yields a `space` (the
// conversation) and an inbound `message`. Reply by awaiting `space.send(...)`.
for await (const [space, message] of app.messages) {
  console.log("inbound:", message.platform, message.content.type);
  if (message.content.type === "text") {
    try {
      await space.send(`echo: ${message.content.text}`);
    } catch (err) {
      console.error("send failed:", err);
    }
  }
}
