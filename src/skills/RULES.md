# Behaviour rules

Every action in the game must follow these rules. Each rule is carried out by a skill in this folder, and [`tests/skills.test.ts`](../../tests/skills.test.ts) checks it, so a change that breaks a rule fails the tests and CI.

When you add or change an action, make it follow these rules. If an action needs a new kind of movement, add it as a skill here instead of moving the character directly.

| ID | Rule | Skill |
| --- | --- | --- |
| R0 | Nothing passes through anything else: people, furniture, walls, the door and props never overlap. 物体之间不可以穿模。 | [`../agent.ts`](../agent.ts) (steering, personal space), [`door.ts`](door.ts), [`detour.ts`](detour.ts), [`../physics.ts`](../physics.ts) |
| R1 | Take the shoes off before lying down in a bed, and put them back on after getting up. 上床睡觉要脱掉鞋子。 | [`bed.ts`](bed.ts) |
| R2 | Walk to the side of the bed, sit down on its edge, then lie down. Get up the same way in reverse. Never lie down from the middle of the bed. 要走到床边，坐下，然后再躺上去休息。 | [`bed.ts`](bed.ts) |
| R3 | To pass the door: reach for the handle, open the door slowly, go through, turn round, and close it. 开门时先伸手找门把手，缓慢推开门，出门，最后转身关门。 | [`door.ts`](door.ts) |
| R4 | When the way is blocked, stop and think whether to take another route. Never push through. 碰到障碍物过不去，就停下来思考是不是要换一条路。 | [`detour.ts`](detour.ts) |

## How a skill works

A skill turns an action into steps (see `Step` in [`index.ts`](index.ts)): walk, squeeze along furniture, turn, change pose, play a body movement, think, take or let go of the door, and start the activity. The agent runs the steps one after another (`Agent.runStep` in [`../agent.ts`](../agent.ts)).

- **Bed (R1, R2):** walk to the end of the bed nearest the way in, squeeze along to its side, turn round, sit on the edge, take the shoes off, lie down. Getting up: sit up on the edge, put the shoes on, stand up (waiting if someone stands there), and step back to the open floor. In the tent, the cots are reached from the aisle between them, where the tent is high enough to stand. Avatars whose shoes are a separate part (material name with "shoe") show them taken off.
- **Door (R3):** the door opens outward into the yard. Going out: reach for the handle, push the door open over 1.6 s, walk through, turn round, reach for the handle, and pull it shut over 1.6 s. Coming in: stand clear of the door's swing, pull it open, walk in, turn round, and push it shut. One person uses the door at a time: they take it before walking up to it, and others wait out of its swing. The door does not move while someone stands where it swings. Only trips between the inside and the outside of the house use the door.
- **Detour (R4):** a walker who gets no closer to where it is going for 1 s stops and thinks. It looks for a route round the people and stuck things in the way. If there is none, it waits and tries again, and after a few tries in one trip it gives up and decides on something else.
- **No clipping (R0):** people keep 0.6 m apart while standing or walking, and a ball that cannot roll away (against a wall or furniture) stops a walker instead of being squashed. Nobody stops for a chat while passing the door or squeezing beside a bed, and people on different sides of the house walls do not meet.
