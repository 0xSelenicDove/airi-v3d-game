# Behaviour rules

Every action in the game must follow these rules. The body carries them out in [`Agent.cs`](Agent.cs) (the routines `PassDoor`, `Sleep`, `UseComputer`, `Eat`, `NavTo`), with the world's physics doing its part. If an action needs a new kind of movement, add a routine there instead of moving the character directly.

| ID | Rule | Where |
| --- | --- | --- |
| R0 | Nothing passes through anything else: people, furniture, walls, the door and props never overlap. 物体之间不可以穿模。 | NavMesh walking (`NavTo`), rigid-body hinges ([`Hinged.cs`](../World/Hinged.cs)), body capsules ([`AvatarRig.cs`](AvatarRig.cs)), cloth blanket ([`SoftBlanket.cs`](../World/SoftBlanket.cs)) |
| R1 | Take the shoes off before lying down in a bed, and put them back on after getting up. 上床睡觉要脱掉鞋子。 | **not ported yet** (the web version did it in `src/skills/bed.ts`, see git history) |
| R2 | Walk to the side of the bed, sit down on its edge, then lie down. Get up the same way in reverse. Never lie down from the middle of the bed. 要走到床边，坐下，然后再躺上去休息。 | `Agent.Sleep` |
| R3 | To pass the door: reach for the handle, open the door slowly, go through, turn round, and close it. 开门时先伸手找门把手，缓慢推开门，出门，最后转身关门。 | `Agent.PassDoor`, `Agent.WithDoor` |
| R4 | When the way is blocked, stop and think whether to take another route. Never push through. 碰到障碍物过不去，就停下来思考是不是要换一条路。 | `Agent.NavTo` |

## How the routines work

- **Door (R3):** one person holds the door at a time (`Hinged.TryHold`). Going out: walk to where the inside handle can be held, put the right hand on it (arm IK), and push. The door is a rigid body on a hinge with a spring, so it follows the hand with weight. The person walks with it, staying 0.42 m from the leaf, which takes them out through the doorway. Then they let go, wait for the door to come to rest (so the NavMesh carves round it), walk round its edge, take the outside handle and walk with it as it shuts. Coming in is the same with the faces swapped.
- **Bed (R2):** walk to the side of the bed that faces the room, turn the back to it, and sit on the edge (the Animator blends into the sitting clip while the hips are lowered onto the mattress). Take the blanket's top edge and throw it back. The blanket is cloth, and its edge is held up past the foot end. Swing the legs up and lie back: the body turns 90° about the hips while the clip blends from sitting to lying. Then the blanket edge comes back down over the chest, and the cloth drapes over the body's capsules. Getting up is the same in reverse.
- **Desk (R0):** the chair is solid and stands pushed in. Take its backrest with both hands and pull it out, stepping back with it. Walk round it, step in between it and the desk until the calves touch the seat, sit down, and slide in with it. Lift the laptop lid with one finger (the lid is a hinged rigid body; its screen lights up when open) and type. Getting up is the same in reverse, and ends with pushing the chair back in.
- **Fridge:** stand in front of it on the handle side, clear of the door's swing. Pull the handle and let go once it swings out of reach, so its weight carries it open. Look in, reach in, and push the door shut; the seal (a stronger spring near closed) pulls it the last bit.
- **Detour (R4):** a walker that gets no closer for 1.5 s stops and thinks. It tries again twice, then gives up and the brain picks something else.
