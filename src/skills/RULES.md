# Behaviour rules

Every action in the game must follow these rules. Each rule is carried out by a skill in this folder, and [`tests/skills.test.ts`](../../tests/skills.test.ts) checks it, so a change that breaks a rule fails the tests and CI.

When you add or change an action, make it follow these rules. If an action needs a new kind of movement, add it as a skill here instead of moving the character directly.

| ID | Rule | Skill |
| --- | --- | --- |
| R0 | Nothing passes through anything else: people, furniture, walls, the door and props never overlap. 物体之间不可以穿模。 | [`../agent.ts`](../agent.ts) (steering, personal space), [`seat.ts`](seat.ts), [`door.ts`](door.ts), [`detour.ts`](detour.ts), [`../physics.ts`](../physics.ts) |
| R1 | Take the shoes off before lying down in a bed, and put them back on after getting up. 上床睡觉要脱掉鞋子。 | [`bed.ts`](bed.ts) |
| R2 | Walk to the side of the bed, sit down on its edge, then lie down. Get up the same way in reverse. Never lie down from the middle of the bed. 要走到床边，坐下，然后再躺上去休息。 | [`bed.ts`](bed.ts) |
| R3 | To pass the door: reach for the handle, open the door slowly, go through, turn round, and close it. 开门时先伸手找门把手，缓慢推开门，出门，最后转身关门。 | [`door.ts`](door.ts) |
| R4 | When the way is blocked, stop and think whether to take another route. Never push through. 碰到障碍物过不去，就停下来思考是不是要换一条路。 | [`detour.ts`](detour.ts) |

## How a skill works

A skill turns an action into steps (see `Step` in [`index.ts`](index.ts)): walk, squeeze along furniture, turn, change pose, play a body movement, think, take or let go of the door, and start the activity. The agent runs the steps one after another (`Agent.runStep` in [`../agent.ts`](../agent.ts)).

- **Bed (R1, R2):** walk to the end of the bed nearest the way in, squeeze along to its side, turn round, sit on the edge, take the shoes off (one foot at a time, both hands on the foot), lie down. Getting up: sit up on the edge, put the shoes on, stand up (waiting if someone stands there), and step back to the open floor. In the tent, the cots are reached from the aisle between them, where the tent is high enough to stand. Avatars whose shoes are a separate part (material name with "shoe") show them taken off.
- **Door (R3):** the door opens outward into the yard, and the hand stays on the handle while the door moves. Going out: reach for the handle, push the door open while stepping into the doorway, walk out and round its edge, turn round, take the handle, and walk with the door as it closes over 2.6 s. Coming in: stand clear of the door's swing, take the handle, walk back with the door as it opens, walk in, turn round as the door swings back, take the inside handle, and pull it shut. One person uses the door at a time: they take it before walking up to it, and others wait out of its swing. The door does not move while someone stands where it swings. Only trips between the inside and the outside of the house use the door.
- **Seat (R0):** walk to the seat's approach point, step forward until the calves touch the seat, turn round, and sit down. Getting up: stand up there and step back. A chair or stool at a table is solid: walk up beside it, pull it out by its top, step in between it and the table, sit down, and slide in with it. Getting up is the same in reverse, and ends with pushing it back in. Sitting down and standing up keep the feet in place while the hips swing up over them (`Agent.rise`), on seats and on a bed's edge. The legs walk whenever the body moves over the floor, also while walking with the door, so nobody glides.
- **Detour (R4):** a walker who gets no closer to where it is going for 1 s stops and thinks. It looks for a route round the people and stuck things in the way. If there is none, it waits and tries again, and after a few tries in one trip it gives up and decides on something else.
- **No clipping (R0):** people keep 0.6 m apart while standing or walking, and a ball that cannot roll away (against a wall or furniture) stops a walker instead of being squashed. Nobody stops for a chat while passing the door or squeezing beside a bed, and people on different sides of the house walls do not meet. The avatars measure their own body at load: the thighs rest on top of a seat, the back and the head rest on top of a mattress or a pillow, and the soles stay above the floor. Hands that touch something (a door handle, a foot, a table, the thighs) are placed by arm IK. Hair and clothes hang under gravity and collide with nearby furniture, walls and the floor.
