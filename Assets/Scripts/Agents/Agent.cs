using System.Collections;
using System.Collections.Generic;
using AiWorld.World;
using UnityEngine;
using UnityEngine.AI;

namespace AiWorld.Agents
{
    /// <summary>
    /// A character that lives in the world. Its brain picks a thing and a verb ("bed → sleep"); the agent then does
    /// it with its body, step by step, following the behaviour rules (see RULES.md next to this file):
    ///
    ///  R0  nothing passes through anything else: walking is on the NavMesh, doors and lids are rigid bodies, and
    ///      the body has colliders;
    ///  R2  to lie down, walk to the side of the bed, turn the quilt back, sit on its edge, lower the body onto its
    ///      side as the legs come up onto the bed, roll onto the back and pull the quilt over; get up in reverse;
    ///  R3  to pass the door, take its handle, walk with it as it swings, go round it, and close it from the other side;
    ///  R4  when the way is blocked, stop and think, try another way, and give up after a few tries.
    /// </summary>
    [RequireComponent(typeof(NavMeshAgent))]
    public class Agent : MonoBehaviour
    {
        public string displayName = "Airi";
        [TextArea] public string persona = "Curious and cheerful. Loves reading on the computer late at night.";
        public AvatarRig rig;

        public readonly Dictionary<Need, float> needs = new()
        {
            [Need.Energy] = 70, [Need.Fun] = 55, [Need.Knowledge] = 50, [Need.Hunger] = 60,
        };
        /// <summary>how fast each need drops, per game minute</summary>
        static readonly Dictionary<Need, float> decay = new()
        {
            [Need.Energy] = 0.05f, [Need.Fun] = 0.09f, [Need.Knowledge] = 0.05f, [Need.Hunger] = 0.08f,
        };

        public string Doing { get; private set; } = "waking up";
        public string Thought { get; private set; }
        public bool Asleep { get; private set; }
        public IBrain brain = new MockBrain();

        NavMeshAgent nav;
        Vector3 lastPos;
        bool ok;               // result of the last step that can fail
        Interactable using_;
        Affordance activity;
        float thoughtUntil;
        Choice? requested;
        bool cutShort;

        /// <summary>
        /// ask for a particular action next (from an LLM, the AIRI bridge, or a test). The current activity ends early
        /// and the body gets up the proper way before starting it. Returns false if there is no such thing or verb.
        /// </summary>
        public bool Request(string objectId, string verb, string reason = null)
        {
            foreach (var it in Interactable.All)
            {
                if (it.id != objectId) continue;
                foreach (var a in it.affordances)
                {
                    if (a.verb != verb) continue;
                    requested = new Choice { target = it, affordance = a, reason = reason };
                    cutShort = true;
                    return true;
                }
            }
            return false;
        }

        void Awake()
        {
            nav = GetComponent<NavMeshAgent>();
            nav.speed = 0.85f;            // a relaxed walk
            nav.acceleration = 2.5f;
            nav.angularSpeed = 200f;
            nav.stoppingDistance = 0.04f;
            nav.radius = 0.24f;
            nav.height = 1.6f;
            nav.autoBraking = true;
            nav.obstacleAvoidanceType = ObstacleAvoidanceType.HighQualityObstacleAvoidance;
            lastPos = transform.position;
        }

        void Start() => StartCoroutine(Live());

        void Update()
        {
            var clock = GameClock.Instance;
            float dm = clock ? clock.DeltaMinutes : Time.deltaTime;
            foreach (Need n in System.Enum.GetValues(typeof(Need)))
            {
                float d = -decay[n];
                if (activity != null && Doing == activity.verb) d += activity.Effect(n) / Mathf.Max(1f, activity.minutes);
                needs[n] = Mathf.Clamp(needs[n] + d * dm, 0, 100);
            }
            // the legs walk whenever the body moves over the floor, whoever moves it (the NavMesh or a door)
            var v = (transform.position - lastPos) / Mathf.Max(Time.deltaTime, 1e-4f);
            v.y = 0;
            lastPos = transform.position;
            if (rig) rig.SetSpeed(rig.State == AvatarRig.Locomotion ? v.magnitude : 0);
            if (Thought != null && Time.time > thoughtUntil) Thought = null;
        }

        void Think(string text, float seconds = 3f)
        {
            Thought = text;
            thoughtUntil = Time.time + seconds;
            Debug.Log($"[{displayName}] {(GameClock.Instance ? GameClock.Instance.Clock : "")} ({text})");
        }

        // ------------------------------------------------------------------ the day

        IEnumerator Live()
        {
            yield return new WaitForSeconds(Random.Range(0.5f, 2f));
            while (true)
            {
                cutShort = false;
                var choice = requested ?? brain.Choose(this, Interactable.All, GameClock.Instance ? GameClock.Instance.Hour : 12f);
                requested = null;
                if (choice.target == null || !choice.target.TryClaim(this))
                {
                    Doing = "idling";
                    yield return new WaitForSeconds(2f);
                    continue;
                }
                using_ = choice.target;
                Think(choice.reason ?? $"I'll {choice.affordance.verb.Replace('_', ' ')}.");
                yield return Use(choice.target, choice.affordance);
                choice.target.Free(this);
                using_ = null;
                activity = null;
                Doing = "idling";
                yield return new WaitForSeconds(Random.Range(0.5f, 1.5f));
            }
        }

        IEnumerator Use(Interactable it, Affordance aff)
        {
            Doing = $"going to the {it.kind}";
            if (it.TryGetComponent(out BedParts bed)) yield return Sleep(bed, aff);
            else if (it.TryGetComponent(out DeskParts desk)) yield return UseComputer(desk, aff);
            else if (it.TryGetComponent(out FridgeParts fridge)) yield return Eat(fridge, aff);
            else if (it.TryGetComponent(out SpotParts spot)) yield return Stroll(it, spot, aff);
        }

        IEnumerator Activity(Affordance aff)
        {
            activity = aff;
            Doing = aff.verb;
            float end = (GameClock.Instance ? GameClock.Instance.Minutes : 0) + aff.minutes;
            while (!cutShort && (GameClock.Instance ? GameClock.Instance.Minutes : end) < end) yield return null;
        }

        // ------------------------------------------------------------------ walking (R0, R3, R4)

        /// <summary>walk to a point, through the front door if it is on the other side of the house wall</summary>
        IEnumerator WalkTo(Vector3 p)
        {
            var house = House.Instance;
            if (house && house.IsInside(transform.position) != house.IsInside(p))
            {
                yield return PassDoor(goingOut: house.IsInside(transform.position));
                if (!ok) yield break;
            }
            yield return NavTo(p);
        }

        /// <summary>NavMesh walking with R4: no progress for 1.5 s → stop, think, try again; give up after 3 tries</summary>
        IEnumerator NavTo(Vector3 p, float arrive = 0.06f)
        {
            ok = false;
            EnsureNav();
            if (NavMesh.SamplePosition(p, out var hit, 0.6f, NavMesh.AllAreas)) p = hit.position;
            for (int attempt = 0; attempt < 3; attempt++)
            {
                nav.isStopped = false;
                nav.SetDestination(p);
                float best = float.MaxValue, since = Time.time;
                while (true)
                {
                    yield return null;
                    if (nav.pathPending) continue;
                    float d = Flat(transform.position - p).magnitude;
                    if (d < arrive || (nav.remainingDistance < arrive && nav.pathStatus == NavMeshPathStatus.PathComplete && d < 0.25f))
                    {
                        nav.isStopped = true;
                        nav.ResetPath();
                        ok = true;
                        yield break;
                    }
                    if (d < best - 0.05f) { best = d; since = Time.time; }
                    else if (Time.time - since > 1.5f) break;
                }
                nav.isStopped = true;
                Think(attempt < 2 ? "Something is in the way… let me find another way round." : "I can't get through. I'll do something else.");
                yield return new WaitForSeconds(1.2f);
            }
        }

        void EnsureNav()
        {
            if (!nav.enabled) nav.enabled = true;
            nav.updatePosition = true;
            nav.updateRotation = true;
            if (!nav.isOnNavMesh) nav.Warp(transform.position);
        }

        /// <summary>move the body by hand (the NavMesh agent only follows), e.g. while walking with the door</summary>
        void Manual(bool on)
        {
            if (on)
            {
                if (nav.enabled && nav.isOnNavMesh) nav.ResetPath();
                nav.updatePosition = false;
                nav.updateRotation = false;
            }
            else
            {
                nav.enabled = true;
                nav.Warp(transform.position);
                nav.updatePosition = true;
                nav.updateRotation = true;
            }
        }

        IEnumerator TurnTo(Vector3 dir, float seconds = 0.6f)
        {
            dir = Flat(dir);
            if (dir.sqrMagnitude < 1e-4f) yield break;
            var from = transform.rotation;
            var to = Quaternion.LookRotation(dir.normalized, Vector3.up);
            for (float t = 0; t < seconds; t += Time.deltaTime)
            {
                transform.rotation = Quaternion.Slerp(from, to, Mathf.SmoothStep(0, 1, t / seconds));
                yield return null;
            }
            transform.rotation = to;
        }

        /// <summary>move the body (not the NavMesh) to a pose: position and facing, over time</summary>
        IEnumerator Glide(Transform to, float seconds)
        {
            Vector3 p0 = transform.position;
            var r0 = transform.rotation;
            // keep the height the body has (the NavMesh's): the hips are lowered onto seats by the rig, and a body
            // moved to the floor's height would jump back up to the NavMesh when it walks again
            var p1 = new Vector3(to.position.x, p0.y, to.position.z);
            for (float t = 0; t < seconds; t += Time.deltaTime)
            {
                float k = Mathf.SmoothStep(0, 1, t / seconds);
                transform.position = Vector3.Lerp(p0, p1, k);
                transform.rotation = Quaternion.Slerp(r0, to.rotation, k);
                yield return null;
            }
            transform.SetPositionAndRotation(p1, to.rotation);
        }

        /// <summary>
        /// R3. Going out: take the inside handle, walk with the door as it opens outward, go round its edge, take the
        /// outside handle and walk with it as it shuts. Coming in is the same with the faces swapped. One person uses
        /// the door at a time.
        /// </summary>
        IEnumerator PassDoor(bool goingOut)
        {
            var house = House.Instance;
            var door = house.door;
            ok = false;
            while (!door.TryHold(this))
            {
                Doing = "waiting for the door";
                yield return new WaitForSeconds(0.5f);
            }
            bool first = !goingOut;    // the face the person starts on: inside face going out, outer face coming in
            Doing = goingOut ? "going out" : "coming in";

            yield return NavTo(house.HoldPoint(first));
            if (!ok) { door.Release(this); yield break; }
            yield return WithDoor(first, 1f);

            yield return NavTo(house.HoldPoint(!first));
            if (!ok) { door.Release(this); yield break; }
            yield return WithDoor(!first, 0f);
            door.Release(this);
            ok = true;
        }

        /// <summary>hold one handle and walk with the door until it reaches an openness (0 shut .. 1 open)</summary>
        IEnumerator WithDoor(bool outer, float openness)
        {
            var house = House.Instance;
            var door = house.door;
            var handle = house.Handle(outer);
            yield return TurnTo(handle.position - transform.position, 0.4f);
            rig.Reach(AvatarIKGoal.RightHand, handle);
            rig.LookAt(handle.position);
            float wait = 0;
            while (!rig.HandArrived(AvatarIKGoal.RightHand) && (wait += Time.deltaTime) < 1.5f) yield return null;

            Manual(true);
            door.Push(openness, 38f);   // slowly: about 2.5 s from shut to open
            float t0 = Time.time;
            while (Mathf.Abs(door.Openness - openness) > 0.04f && Time.time - t0 < 6f)
            {
                var want = house.HoldPoint(outer);
                transform.position = Vector3.MoveTowards(transform.position, want, 1.0f * Time.deltaTime);
                var face = Flat(handle.position - transform.position);
                if (face.sqrMagnitude > 1e-3f)
                    transform.rotation = Quaternion.Slerp(transform.rotation, Quaternion.LookRotation(face), Time.deltaTime * 5f);
                rig.LookAt(handle.position);
                yield return null;
            }
            rig.LetGo(AvatarIKGoal.RightHand);
            rig.LookAt(null);
            Manual(false);
            // let the door come to rest, so the NavMesh carves round it before walking round it
            var body = door.GetComponent<Rigidbody>();
            float settle = 0;
            for (float t = 0; t < 2f && settle < 0.4f; t += Time.deltaTime)
            {
                settle = body.angularVelocity.magnitude < 0.05f ? settle + Time.deltaTime : 0;
                yield return null;
            }
        }

        // ------------------------------------------------------------------ bed (R2)

        IEnumerator Sleep(BedParts bed, Affordance aff)
        {
            yield return WalkTo(bed.side.position);
            if (!ok) yield break;
            Manual(true);
            float top = bed.mattressTop;
            var lieRot = bed.lie.rotation;
            // where the hips are while lying on the side, facing the room: a little toward the room from lying on the back
            var onSide = bed.lie.position + bed.side.forward * 0.14f;

            // bend over the bed, take the quilt by its edge and turn it back onto the half by the wall
            Doing = "turning the quilt back";
            yield return TurnBlanket(bed, 1f);

            // turn the back to the bed and sit down on its edge, the feet on the floor
            Doing = "getting into bed";
            yield return TurnTo(bed.sit.forward, 0.6f);
            nav.enabled = false;
            rig.FitOnto(bed.transform, bed.mattressHalf, top);
            // the feet stay where they stand while the hips go back and down onto the edge
            rig.PlantFeetHere(bed.sit.forward);
            rig.Play(AvatarRig.Sit, 1.0f);
            yield return SitBackOnto(bed.sit, 1.1f, top + 0.06f);
            yield return new WaitForSeconds(0.5f);

            // lie down the way people are taught to (the log roll): the arms lower the upper body onto its side while
            // the legs rise onto the bed. The clip is made facing the foot end, so the root turns to face it now; the
            // clip's first pose is sitting facing the room, so the body does not move when it does.
            rig.SetMirror(!RoomOnLeft(bed));
            transform.rotation = lieRot;
            rig.PlayNow(AvatarRig.SideDown);
            rig.PlantFeet(null);
            yield return LogRoll(bed.sit.position, onSide, lieRot, 2.6f, down: true);
            yield return new WaitForSeconds(0.25f);

            // roll onto the back
            rig.Play(AvatarRig.RollBack, 0.2f);
            yield return Move(bed.lie.position, lieRot, 1.4f, top + 0.16f, top + 0.1f);
            rig.Play(AvatarRig.Lie, 0.5f);
            yield return new WaitForSeconds(0.4f);

            // reach for the quilt's edge and pull it over: it lands on the body from above (the body is a cloth
            // collider, grown in gently so the folded quilt beside the body is eased aside, not knocked)
            rig.FitClothCapsules();
            rig.FadeClothCapsules(0f, 0f);
            bed.blanket.SetBodyColliders(rig.ClothCapsules, bed.mattress);
            rig.FadeClothCapsules(1f, 0.4f);
            yield return new WaitForSeconds(0.45f);
            bed.blanket.Sleeper(true, rig.ClothCapsules);
            yield return HandOnQuilt(bed, 0f, 0.3f);
            while (bed.blanket.Folded > 0.02f) yield return null;
            Asleep = true;
            // sleep through the night: once the time is up, sleep on until morning (unless asked to get up)
            yield return Activity(aff);
            while (!cutShort && IsNight()) yield return null;   // still sleeping (and resting): Doing stays "sleep"
            Asleep = false;

            // getting up is the same in reverse: throw the quilt back, roll onto the side facing the room, push up
            // with the arms while the legs go down to the floor, and stand
            Doing = "getting up";
            yield return HandOnQuilt(bed, 1f, 0.45f);
            while (bed.blanket.Folded < 0.98f) yield return null;
            // the quilt is off: shrink the body away from the cloth (it lets go of the quilt once the bed is made)
            rig.FadeClothCapsules(0f, 0.5f);
            yield return new WaitForSeconds(0.55f);
            bed.blanket.Sleeper(false);
            rig.Play(AvatarRig.RollSide, 0.25f);
            yield return Move(onSide, lieRot, 1.4f, top + 0.1f, top + 0.16f);
            yield return new WaitForSeconds(0.2f);
            rig.Play(AvatarRig.SideUp, 0.15f);
            yield return LogRoll(bed.sit.position, onSide, lieRot, 2.6f, down: false);
            // sitting on the edge facing the room again: the root turns back under the body
            transform.rotation = bed.sit.rotation;
            rig.PlayNow(AvatarRig.Sit);
            rig.PlantFeet(bed.sit.position, bed.sit.forward);
            yield return new WaitForSeconds(0.8f);
            yield return StandUp(bed.side, rejoinNav: false);
            rig.FitOff();

            // make the bed: lay the quilt back over it
            Doing = "making the bed";
            yield return TurnBlanket(bed, 0f);
            // (the shrunk body capsules leave the quilt only now that it lies flat, so nothing in it springs back)
            bed.blanket.SetBodyColliders(null, bed.mattress);
            rig.UnfitClothCapsules();
            rig.FadeClothCapsules(1f, 0f);
            Manual(false);
        }

        /// <summary>is the room on the left of someone lying in this bed? (the bed clips are made that way round)</summary>
        static bool RoomOnLeft(BedParts bed) => Vector3.Dot(bed.side.forward, -bed.lie.right) > 0f;

        /// <summary>
        /// lying in bed: take the quilt's edge with the nearer hand and pull it over (to 0) or throw it back (to 1); the
        /// hand goes with the edge until the quilt is <paramref name="letGoAt"/> of the way, then its weight carries it on
        /// </summary>
        IEnumerator HandOnQuilt(BedParts bed, float to, float letGoAt)
        {
            var grip = bed.blanket.grip;
            var anim = rig.Animator;
            var l = anim.GetBoneTransform(HumanBodyBones.LeftUpperArm);
            var r = anim.GetBoneTransform(HumanBodyBones.RightUpperArm);
            var hand = l && r && (grip.position - l.position).sqrMagnitude < (grip.position - r.position).sqrMagnitude
                ? AvatarIKGoal.LeftHand : AvatarIKGoal.RightHand;
            rig.ClothArm(hand, false);
            rig.Reach(hand, grip);
            rig.LookAt(grip.position);
            float wait = 0;
            while (!rig.HandArrived(hand) && (wait += Time.deltaTime) < 0.9f) yield return null;
            bed.blanket.Fold(to);
            float from = bed.blanket.Folded;
            while (Mathf.Abs(bed.blanket.Folded - from) < Mathf.Abs(to - from) * letGoAt)
            {
                rig.LookAt(grip.position);
                yield return null;
            }
            rig.LetGo(hand);
            rig.LookAt(null);
            // the arm lies under the quilt again once the quilt has landed
            while (Mathf.Abs(bed.blanket.Folded - to) > 0.02f) yield return null;
            rig.ClothArm(hand, true);
        }

        /// <summary>
        /// the body's path while the SideDown (or, reversed, SideUp) clip plays: the hips stay over the edge while the
        /// trunk tips onto its side (they only rise as it tips: the lower hip goes down as the trunk goes over), and
        /// they move in toward the middle of the bed as the legs come up (moving in earlier would drag the hanging
        /// legs into the mattress)
        /// </summary>
        IEnumerator LogRoll(Vector3 sitting, Vector3 onSide, Quaternion facing, float seconds, bool down)
        {
            float top = 0;
            if (using_ && using_.TryGetComponent(out BedParts bed)) top = bed.mattressTop;
            float y = transform.position.y;
            for (float t = 0; ; t += Time.deltaTime)
            {
                float k = Mathf.Clamp01(t / seconds);
                float kd = down ? k : 1f - k;     // where the clip is, as if lying down
                float tip = Mathf.SmoothStep(0, 1, Mathf.Clamp01(kd / 0.6f));
                float inward = Mathf.SmoothStep(0, 1, Mathf.Clamp01((kd - 0.35f) / 0.65f));
                var p = Vector3.Lerp(sitting, onSide, inward);
                transform.SetPositionAndRotation(new Vector3(p.x, y, p.z), facing);
                // sitting: the hips 6 cm over the mattress; on the side: 16 cm (half the pelvis); on the way, higher still
                rig.HoldHipsAt(top + Mathf.Lerp(0.06f, 0.16f, tip) + 0.09f * Mathf.Sin(Mathf.PI * tip));
                if (k >= 1f) break;
                yield return null;
            }
        }

        /// <summary>
        /// sit down onto something behind: the hips go back first and come down as they get over it, so the seat
        /// never catches its edge on the way
        /// </summary>
        IEnumerator SitBackOnto(Transform seat, float seconds, float hipsTo)
        {
            var hipsBone = rig.Animator.GetBoneTransform(HumanBodyBones.Hips);
            float hipsFrom = hipsBone ? hipsBone.position.y : hipsTo + 0.35f;
            Vector3 p0 = transform.position;
            var r0 = transform.rotation;
            var p1 = new Vector3(seat.position.x, p0.y, seat.position.z);
            for (float t = 0; t < seconds; t += Time.deltaTime)
            {
                float k = t / seconds;
                float back = Mathf.SmoothStep(0, 1, Mathf.Clamp01(k / 0.8f));
                float down = Mathf.SmoothStep(0, 1, Mathf.Clamp01((k - 0.25f) / 0.75f));
                transform.SetPositionAndRotation(Vector3.Lerp(p0, p1, back), Quaternion.Slerp(r0, seat.rotation, back));
                rig.HoldHipsAt(Mathf.Lerp(hipsFrom, hipsTo, down));
                yield return null;
            }
            transform.SetPositionAndRotation(p1, seat.rotation);
            rig.HoldHipsAt(hipsTo);
        }

        /// <summary>move the body over the bed (its height stays the NavMesh's) and lower or raise the hips with it</summary>
        IEnumerator Move(Vector3 to, Quaternion facing, float seconds, float hipsFrom, float hipsTo)
        {
            Vector3 p0 = transform.position;
            var r0 = transform.rotation;
            var p1 = new Vector3(to.x, p0.y, to.z);
            for (float t = 0; t < seconds; t += Time.deltaTime)
            {
                float k = Mathf.SmoothStep(0, 1, t / seconds);
                transform.SetPositionAndRotation(Vector3.Lerp(p0, p1, k), Quaternion.Slerp(r0, facing, k));
                rig.HoldHipsAt(Mathf.Lerp(hipsFrom, hipsTo, k));
                yield return null;
            }
            transform.SetPositionAndRotation(p1, facing);
            rig.HoldHipsAt(hipsTo);
        }

        /// <summary>standing beside the bed: bend over, take the quilt's edge, and turn it back (1) or lay it over (0)</summary>
        IEnumerator TurnBlanket(BedParts bed, float to)
        {
            yield return TurnTo(-bed.side.forward, 0.5f);
            rig.Play(AvatarRig.Stoop, 0.6f);
            rig.LookAt(bed.blanket.grip.position);
            yield return new WaitForSeconds(0.35f);
            rig.Reach(AvatarIKGoal.RightHand, bed.blanket.grip);
            float wait = 0;
            while (!rig.HandArrived(AvatarIKGoal.RightHand) && (wait += Time.deltaTime) < 1f) yield return null;
            bed.blanket.Fold(to);
            // the hand goes with the edge as far as it reaches, then lets the quilt's weight carry it over
            while (Mathf.Abs(bed.blanket.Folded - to) > 0.55f) { rig.LookAt(bed.blanket.grip.position); yield return null; }
            rig.LetGo(AvatarIKGoal.RightHand);
            rig.Play(AvatarRig.Locomotion, 0.7f);
            while (Mathf.Abs(bed.blanket.Folded - to) > 0.02f) yield return null;
            rig.LookAt(null);
            yield return new WaitForSeconds(0.3f);
        }

        /// <summary>
        /// stand up over the planted feet: lean forward first, then rise as the hips move over the feet;
        /// <paramref name="rejoinNav"/> = false where the NavMesh does not reach (beside a desk) or more follows by hand
        /// </summary>
        IEnumerator StandUp(Transform to, bool rejoinNav = true)
        {
            rig.Play(AvatarRig.SitLean, 0.45f);
            yield return new WaitForSeconds(0.45f);
            rig.Play(AvatarRig.Locomotion, 0.8f);
            rig.HoldHipsAt(null);
            rig.PlantFeet(null);
            yield return Glide(to, 0.8f);
            if (rejoinNav) Manual(false);
        }

        // ------------------------------------------------------------------ desk

        IEnumerator UseComputer(DeskParts desk, Affordance aff)
        {
            var chair = desk.chair;
            var toDesk = Flat(desk.stepIn.forward).normalized;

            // pull the chair out by its backrest, stepping back with it
            yield return WalkTo(desk.behind.position);
            if (!ok) yield break;
            Doing = "pulling the chair out";
            yield return MoveChair(chair, 1f, toDesk);

            // round the chair, in between it and the desk, and sit down with the calves against the seat
            yield return NavTo(desk.side.position, 0.1f);
            Manual(true);
            yield return StepTo(desk.stepIn.position, toDesk);
            Doing = "sitting down";
            nav.enabled = false;
            rig.Play(AvatarRig.Sit, 0.8f);
            rig.HoldHipsAt(desk.seatTop + 0.07f);
            rig.PlantFeet(chair.seat.position, chair.seat.forward);
            yield return Glide(chair.seat, 0.8f);
            // and slide in to the desk with the chair, the feet walking it in
            chair.Slide(0f, 0.35f);
            while (chair.Moving) { transform.position = chair.seat.position; rig.PlantFeet(chair.seat.position, chair.seat.forward); yield return null; }
            transform.position = chair.seat.position;
            rig.PlantFeet(chair.seat.position, chair.seat.forward);

            // open the lid with the right hand
            rig.Reach(AvatarIKGoal.RightHand, desk.lidEdge);
            rig.LookAt(desk.lidEdge.position);
            yield return new WaitForSeconds(0.5f);
            desk.lid.Push(1f, 70f);
            while (desk.lid.Openness < 0.85f) yield return null;
            rig.LetGo(AvatarIKGoal.RightHand);
            rig.Play(AvatarRig.Type, 0.6f);
            rig.LookAt(desk.screen.position);
            yield return Activity(aff);

            Doing = "closing the laptop";
            rig.Play(AvatarRig.Sit, 0.5f);
            rig.Reach(AvatarIKGoal.RightHand, desk.lidEdge);
            yield return new WaitForSeconds(0.5f);
            desk.lid.Push(0f, 80f);
            while (!desk.lid.IsClosed) yield return null;
            rig.LetGo(AvatarIKGoal.RightHand);
            rig.LookAt(null);

            // slide out with the chair, stand up over the feet, step out and push the chair back in
            Doing = "getting up";
            chair.Slide(1f, 0.35f);
            while (chair.Moving) { transform.position = chair.seat.position; rig.PlantFeet(chair.seat.position, chair.seat.forward); yield return null; }
            yield return StandUp(desk.stepIn, rejoinNav: false);
            Manual(true);
            yield return StepTo(desk.side.position, -Flat(desk.side.position - desk.stepIn.position));
            Manual(false);
            yield return NavTo(chair.GripCentre - toDesk * 0.38f, 0.1f);
            Doing = "pushing the chair in";
            yield return MoveChair(chair, 0f, toDesk);
            Manual(true);
            yield return StepTo(transform.position - toDesk * 0.25f, toDesk);
            Manual(false);
        }

        /// <summary>both hands on the backrest, then walk with the chair as it slides in or out</summary>
        IEnumerator MoveChair(SlidingChair chair, float to, Vector3 toDesk)
        {
            yield return TurnTo(toDesk, 0.4f);
            rig.Reach(AvatarIKGoal.LeftHand, chair.gripLeft);
            rig.Reach(AvatarIKGoal.RightHand, chair.gripRight);
            rig.LookAt(chair.GripCentre);
            float wait = 0;
            while (!rig.HandArrived(AvatarIKGoal.RightHand) && (wait += Time.deltaTime) < 1.5f) yield return null;
            Manual(true);
            chair.Slide(to);
            while (chair.Moving)
            {
                var want = chair.GripCentre - toDesk * 0.38f;
                want.y = 0;
                transform.position = Vector3.MoveTowards(transform.position, want, 1.2f * Time.deltaTime);
                yield return null;
            }
            rig.LetGo(AvatarIKGoal.LeftHand);
            rig.LetGo(AvatarIKGoal.RightHand);
            rig.LookAt(null);
            yield return new WaitForSeconds(0.3f);
            Manual(false);
        }

        /// <summary>walk a short way by hand (where the NavMesh is too tight, e.g. between a chair and a desk)</summary>
        IEnumerator StepTo(Vector3 p, Vector3 face, float speed = 0.55f)
        {
            p.y = transform.position.y;
            var look = Flat(face).sqrMagnitude > 1e-4f ? Quaternion.LookRotation(Flat(face).normalized) : transform.rotation;
            while (Flat(transform.position - p).magnitude > 0.01f)
            {
                transform.position = Vector3.MoveTowards(transform.position, p, speed * Time.deltaTime);
                transform.rotation = Quaternion.Slerp(transform.rotation, look, Time.deltaTime * 5f);
                yield return null;
            }
            transform.rotation = look;
        }

        // ------------------------------------------------------------------ fridge

        IEnumerator Eat(FridgeParts fridge, Affordance aff)
        {
            yield return WalkTo(fridge.front.position);
            if (!ok) yield break;
            yield return TurnTo(fridge.front.forward, 0.5f);
            Doing = "opening the fridge";
            var handle = fridge.door.handleFront;
            rig.Reach(AvatarIKGoal.RightHand, handle);
            rig.LookAt(handle.position);
            yield return new WaitForSeconds(0.6f);
            // pull it open; let go when it swings out of reach and let its weight carry it the rest of the way
            fridge.door.Push(1f, 90f);
            while (fridge.door.Openness < 0.5f) yield return null;
            rig.LetGo(AvatarIKGoal.RightHand);
            yield return new WaitForSeconds(0.4f);

            Doing = "looking in the fridge";
            rig.LookAt(fridge.shelf.position);
            yield return new WaitForSeconds(1.0f);
            rig.Reach(AvatarIKGoal.RightHand, fridge.shelf);
            yield return new WaitForSeconds(1.0f);
            rig.LetGo(AvatarIKGoal.RightHand);
            yield return new WaitForSeconds(0.5f);

            Doing = "closing the fridge";
            rig.Reach(AvatarIKGoal.LeftHand, fridge.pushPoint);
            rig.LookAt(fridge.pushPoint.position);
            yield return new WaitForSeconds(0.5f);
            fridge.door.Push(0f, 120f);
            while (fridge.door.Openness > 0.3f) yield return null;
            rig.LetGo(AvatarIKGoal.LeftHand);     // the seal pulls it shut
            rig.LookAt(null);
            rig.Play(AvatarRig.Eat, 0.5f);
            yield return Activity(aff);
            rig.Play(AvatarRig.Locomotion, 0.5f);
        }

        // ------------------------------------------------------------------ outside

        IEnumerator Stroll(Interactable it, SpotParts spot, Affordance aff)
        {
            yield return WalkTo(it.approach.position);
            if (!ok) yield break;
            activity = aff;
            Doing = aff.verb;
            float end = (GameClock.Instance ? GameClock.Instance.Minutes : 0) + aff.minutes;
            int i = 0;
            while (!cutShort && (GameClock.Instance ? GameClock.Instance.Minutes : end) < end)
            {
                if (spot.lookPoints.Length > 0) rig.LookAt(spot.lookPoints[i++ % spot.lookPoints.Length].position);
                yield return new WaitForSeconds(Random.Range(2f, 4f));
            }
            rig.LookAt(null);
        }

        static bool IsNight()
        {
            float h = GameClock.Instance ? GameClock.Instance.Hour : 12f;
            return h >= 22f || h < 6.5f;
        }

        static Vector3 Flat(Vector3 v) => new(v.x, 0, v.z);

        void OnDisable()
        {
            if (using_) using_.Free(this);
        }
    }
}
