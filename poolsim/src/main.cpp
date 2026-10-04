// pool-sim: a command-line front end for OpenPigeon's 8 Ball physics (PoolTable, unmodified).
//
// It replaces the Android (JNI) wrapper so the engine can be driven from a pipe. One command
// per line on stdin:
//
//   reset <first>                                 new empty table. first=1 for a break shot
//   ball <number> <x> <y> <rot> <density> <mode>  add a ball. number 0 is the cue ball.
//                                                 mode 0 = plain physics (1 and 2 are replay assists)
//   hit <dir> <power> <spinX> <spinY>             strike the cue ball and run until everything stops
//   trace <n>                                     also print every ball every n frames to stderr (0 = off)
//   quit
//
// After each hit it prints:
//
//   result frames=<n> scratch=<0|1> cuehit=<first ball the cue touched, or -1> timeout=<0|1>
//   ball <number> <x> <y> <rot> <sunkOrder> <firstBallTouched> <pocketX> <pocketY>   one line per ball, in the order added
//   end
//
// sunkOrder is -1 for a ball still on the table; pocketX/pocketY are the pocket it fell into, or -1. Errors print "error <message>".
// Several hits may follow one reset: the engine drops pocketed balls before each.

#include <Box2D/Box2D.h>
#include <cstdio>
#include <deque>
#include <iostream>
#include <memory>
#include <sstream>
#include <string>

#include "PoolTable.h"

// Defined in the Box2D fork. The engine changes it mid-shot, so it must be restored per table.
void set_custom_slop(float32 slop);

namespace {
// Outputs the engine writes for each ball: x, y, angle, sunkOrder, numberHit, holeX, holeY, vx, vy, angularVelocity.
struct Slot {
    int number;
    float out[10];
};

// A shot that has not settled after this many 1/60 s frames is reported as a timeout.
constexpr int MAX_FRAMES = 60 * 120;

std::unique_ptr<PoolTable> table;
std::deque<Slot> slots; // deque: the engine keeps pointers into these, so they must not move
bool first = false;
int traceEvery = 0;

void reset(bool isFirst) {
    // A fresh table per position, so a result never depends on what was simulated before it.
    table = std::make_unique<PoolTable>();
    slots.clear();
    first = isFirst;
    set_custom_slop(b2_linearSlop);
}

void hit(float dir, float power, float spinX, float spinY) {
    table->hitBall(0, dir, power, spinX, spinY, first);
    first = false;

    const Slot* cue = nullptr;
    for (const auto& slot : slots) {
        if (slot.number == 0) cue = &slot;
    }

    int frames = 0;
    bool scratch = false;
    bool moving = true;
    while (moving && frames < MAX_FRAMES) {
        moving = table->update();
        frames++;
        // The engine returns a pocketed cue ball to the center spot, so catch it while it is in the pocket.
        if (cue != nullptr && cue->out[5] != -1.0f) scratch = true;
        if (traceEvery > 0 && frames % traceEvery == 0) {
            for (const auto& slot : slots) {
                std::fprintf(stderr, "frame %d ball %d %.4f %.4f v %.3f %.3f\n", frames, slot.number, slot.out[0], slot.out[1],
                             slot.out[7], slot.out[8]);
            }
        }
    }

    std::printf("result frames=%d scratch=%d cuehit=%d timeout=%d\n", frames, scratch ? 1 : 0,
                cue != nullptr ? static_cast<int>(cue->out[4]) : -1, moving ? 1 : 0);
    for (const auto& slot : slots) {
        std::printf("ball %d %.9g %.9g %.9g %d %d %.9g %.9g\n", slot.number, slot.out[0], slot.out[1], slot.out[2],
                    static_cast<int>(slot.out[3]), static_cast<int>(slot.out[4]), slot.out[5], slot.out[6]);
    }
    std::printf("end\n");
}
} // namespace

int main() {
    std::string line;
    while (std::getline(std::cin, line)) {
        std::istringstream in(line);
        std::string command;
        if (!(in >> command)) continue;

        if (command == "quit") {
            break;
        } else if (command == "trace") {
            in >> traceEvery;
        } else if (command == "reset") {
            int isFirst = 0;
            in >> isFirst;
            reset(isFirst != 0);
        } else if (command == "ball") {
            int number = 0;
            int mode = 0;
            float x = 0, y = 0, rot = 0, density = 1;
            if (!(in >> number >> x >> y >> rot >> density >> mode) || !table) {
                std::printf("error bad ball line, or no reset before it\n");
            } else {
                slots.push_back(Slot{number, {x, y, rot, -1, -1, -1, -1, 0, 0, 0}});
                table->makeBall(b2Vec2(x, y), rot, density, number, mode, slots.back().out);
            }
        } else if (command == "hit") {
            float dir = 0, power = 0, spinX = 0, spinY = 0;
            if (!(in >> dir >> power >> spinX >> spinY) || !table) {
                std::printf("error bad hit line, or no reset before it\n");
            } else {
                hit(dir, power, spinX, spinY);
            }
        } else {
            std::printf("error unknown command %s\n", command.c_str());
        }
        std::fflush(stdout);
    }
    return 0;
}
