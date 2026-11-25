using System.Linq;
using UnityEngine;

namespace AiWorld.World
{
    /// <summary>
    /// A quilt that is real cloth. It is turned back the way a person does it by hand: the half nearest the room is
    /// taken by its corner (<see cref="grip"/>), the corner comes up first, and the rest follows along the bed as it is
    /// laid over onto the half by the wall. The part that does not fit leans up against the wall. Laying it back
    /// covers whoever lies in the bed, again corner first. The quilt never leaves the bed.
    ///
    /// The cloth follows a skinned pose: the bed (the far half), <see cref="hinges"/> (the near half in bands along the
    /// bed, which turn over about a line just past where a sleeper lies, the band at the grip first) and
    /// <see cref="wallFolds"/> (the part of each band that leans on the wall). How far each vertex may stray from that pose depends on what the quilt is doing:
    ///  * lying made on an empty bed or folded back: close (it keeps its shape, its overhang drapes down the sides);
    ///  * turning over: a little more, so it sags with its weight as it goes (over a sleeper too: its arc and its
    ///    end pose are above the body, so it never passes through them);
    ///  * resting over a sleeper: enough to fall onto the body and drape round it, but not to slide off it during a
    ///    night of simulation.
    /// Limits loosen at once and tighten gradually (a sudden limit snaps vertices back).
    /// </summary>
    [RequireComponent(typeof(Cloth))]
    public class SoftBlanket : MonoBehaviour
    {
        [Tooltip("turn the near half over, one band along the bed each (children of the blanket)")]
        public Transform[] hinges;
        [Tooltip("the part of each band past the wall-side edge of the mattress once folded: it leans up the wall (children of the hinges)")]
        public Transform[] wallFolds;
        [Tooltip("how far each band is from the grip along the bed: 0 at the grip's band, 1 at the farthest")]
        public float[] bandFromGrip;
        [Tooltip("where someone lying in the bed takes the quilt: the middle of its near edge (the corner is above the shoulder, and the arm went into the mattress reaching for it)")]
        public Transform lyingGrip;
        [Tooltip("how far each band is from the lying grip along the bed")]
        public float[] bandFromLyingGrip;
        [Tooltip("how far behind the grip's band the farthest band starts turning, as a share of the whole turn")]
        public float peel = 0.8f;
        [Tooltip("where a hand takes the quilt to turn it back: its corner on the near edge, toward the head end")]
        public Transform grip;
        [Tooltip("the axis both folds turn about, in the hinge's space")]
        public Vector3 axis = Vector3.forward;
        [Tooltip("how far the wall part turns up, once the quilt is over")]
        public float wallAngle = -90f;
        [Tooltip("how high the turn line rises half way through a turn, so the quilt goes over a sleeper, not through (m)")]
        public float liftEmpty = 0.12f, liftSleeper = 0.45f;
        [Tooltip("over a sleeper, the near half is laid down from this high over the mattress and drapes onto the body (m)")]
        public float coverHeight = 0.4f;
        [Tooltip("seconds to turn it back or lay it over: a heavy quilt, moved by one hand")]
        public float seconds = 3.2f;

        [Header("How far vertices may move from the skinned pose (m)")]
        public float settled = 0.03f;
        public float turning = 0.16f;
        [Tooltip("folded back, how far the part against the wall may slump from standing upright (m): it is heavy")]
        public float slump = 0.22f;
        [Tooltip("over a sleeper, how much higher than the body under it a vertex may rise (m)")]
        public float overBody = 0.07f;
        [Tooltip("for vertices past the mattress (the overhang): this much more, so it hangs down the side")]
        public float overhangExtra = 0.04f;
        [Tooltip("metres per second at which a limit tightens (it loosens at once)")]
        public float tighten = 0.3f;
        [Tooltip("which vertices are over the mattress: half size (x across, y along) and centre, in the blanket's space")]
        public Vector2 mattressHalf = new(0.475f, 1.025f);
        public Vector3 mattressCentre;
        public Vector3 acrossLocal = Vector3.right, alongLocal = Vector3.forward;

        float fold, foldTarget, lastChange;
        bool toBack = true, byLyingGrip;
        Vector3[] hingeRest;
        float raise;
        bool sleeper;
        Cloth cloth;
        bool[] isOverhang, isWallPart;
        int gripVertex = -1, lyingGripVertex = -1;
        float[] limit, sleeperLimit;
        ClothSkinningCoefficient[] coeffs;

        /// <summary>nothing has moved it for a while: it lies still (its drawn shape need not follow the cloth's settling)</summary>
        public bool Still => Time.time - lastChange > 1.5f;

        /// <summary>0 = covering the bed, 1 = turned back to the wall</summary>
        public float Folded => fold;

        void Awake()
        {
            cloth = GetComponent<Cloth>();
            hingeRest = hinges.Select(h => h.localPosition).ToArray();
            coeffs = cloth.coefficients;
            isOverhang = new bool[coeffs.Length];
            isWallPart = new bool[coeffs.Length];
            var weights = GetComponent<SkinnedMeshRenderer>().sharedMesh.boneWeights;
            for (int i = 0; i < isWallPart.Length && i < weights.Length; i++) isWallPart[i] = weights[i].boneIndex0 > hinges.Length;
            limit = new float[coeffs.Length];
            sleeperLimit = new float[coeffs.Length];
            var verts = GetComponent<SkinnedMeshRenderer>().sharedMesh.vertices;
            for (int i = 0; i < coeffs.Length; i++)
            {
                var d = verts[i] - mattressCentre;
                isOverhang[i] = Mathf.Abs(Vector3.Dot(d, acrossLocal)) > mattressHalf.x || Mathf.Abs(Vector3.Dot(d, alongLocal)) > mattressHalf.y;
                limit[i] = coeffs[i].maxDistance;
            }
            // the hand takes the quilt where its edge really is (it sags and slumps), not where it would be
            int Nearest(Transform at)
            {
                if (!at) return -1;
                var g = transform.InverseTransformPoint(at.position);
                int found = -1;
                float best = float.MaxValue;
                for (int i = 0; i < verts.Length; i++)
                {
                    float d = (verts[i] - g).sqrMagnitude;
                    if (d < best) { best = d; found = i; }
                }
                return found;
            }
            gripVertex = Nearest(grip);
            lyingGripVertex = Nearest(lyingGrip);
        }

        /// <summary>
        /// turn the quilt back (1) or lay it over the bed (0), taken by <see cref="grip"/>, or by
        /// <see cref="lyingGrip"/> from inside the bed. The part of the quilt at the hand goes first.
        /// </summary>
        public void Fold(float amount, bool fromLying = false)
        {
            foldTarget = Mathf.Clamp01(amount);
            if (!Mathf.Approximately(foldTarget, fold))
            {
                toBack = foldTarget > fold;
                byLyingGrip = fromLying && lyingGrip && bandFromLyingGrip != null && bandFromLyingGrip.Length == hinges.Length;
            }
        }

        /// <summary>how far the part the hand holds has gone on its way (0 where it started, 1 where it ends)</summary>
        public float GripTurned => Travelled(0f);

        /// <summary>how far a band this far from the grip has gone on its way: the far bands start later and catch up</summary>
        float Travelled(float fromGrip) => Mathf.Clamp01((toBack ? fold : 1f - fold) * (1f + peel) - peel * fromGrip);

        /// <summary>how far a band is turned over (0 lying on the bed, 1 laid over onto the wall half)</summary>
        float BandFold(int k)
        {
            float t = Travelled(byLyingGrip ? bandFromLyingGrip[k] : bandFromGrip[k]);
            return toBack ? t : 1f - t;
        }

        /// <summary>
        /// someone lies in the bed (pass their cloth capsules as they lie), or got up (false). Each vertex may then rise
        /// only as high as the body is under it, plus a little: the quilt rests on the body and drapes down beside
        /// it, and it cannot slide off the rounded body during the night.
        /// </summary>
        public void Sleeper(bool on, CapsuleCollider[] body = null)
        {
            sleeper = on;
            lastChange = Time.time;
            if (!on || body == null) return;
            var verts = GetComponent<SkinnedMeshRenderer>().sharedMesh.vertices;
            for (int i = 0; i < verts.Length; i++)
            {
                var w = transform.TransformPoint(verts[i]);
                float top = 0f;
                foreach (var c in body)
                {
                    if (!c || !c.enabled) continue;
                    float half = Mathf.Max(0f, c.height * 0.5f - c.radius);
                    var a = c.transform.TransformPoint(c.center + Vector3.forward * -half);
                    var b = c.transform.TransformPoint(c.center + Vector3.forward * half);
                    // the point of the capsule's axis nearest this vertex, seen from above
                    var ab = new Vector2(b.x - a.x, b.z - a.z);
                    var av = new Vector2(w.x - a.x, w.z - a.z);
                    float t = ab.sqrMagnitude > 1e-6f ? Mathf.Clamp01(Vector2.Dot(av, ab) / ab.sqrMagnitude) : 0f;
                    var p = Vector3.Lerp(a, b, t);
                    float d = new Vector2(w.x - p.x, w.z - p.z).magnitude;
                    // over the body: its top; beside it: a slope down from its side, so the quilt drapes off the
                    // body in a ramp instead of being held flat right up against it
                    float h = d < c.radius ? Mathf.Sqrt(c.radius * c.radius - d * d) : -(d - c.radius);
                    top = Mathf.Max(top, p.y + h - w.y);
                }
                sleeperLimit[i] = Mathf.Max(settled, top + overBody);
            }
        }

        /// <summary>make the cloth collide with these (a sleeper's body) as well as the mattress; pass null to clear</summary>
        public void SetBodyColliders(CapsuleCollider[] body, CapsuleCollider[] mattress)
        {
            lastChange = Time.time;
            int n = (body?.Length ?? 0) + (mattress?.Length ?? 0);
            var all = new CapsuleCollider[n];
            int i = 0;
            if (mattress != null) foreach (var c in mattress) all[i++] = c;
            if (body != null) foreach (var c in body) all[i++] = c;
            cloth.capsuleColliders = all;
        }

        void Update()
        {
            if (hinges == null || hinges.Length == 0) return;
            // over a sleeper it goes slower: it is lifted off (or laid over) a body, not flung across an empty bed
            fold = Mathf.MoveTowards(fold, foldTarget, Time.deltaTime / Mathf.Max(sleeper ? seconds * 1.4f : seconds, 0.01f));
            bool turningNow = !Mathf.Approximately(fold, foldTarget);
            float mean = 0f;
            for (int k = 0; k < hinges.Length; k++) mean += Mathf.SmoothStep(0, 1, BandFold(k)) / hinges.Length;
            // over a sleeper the near half ends up held above the body, not flat on the mattress through it, and
            // falls the last bit onto them with its weight
            // (once it has landed, that hold comes down to the bed, and each vertex rests on whatever is under it)
            raise = Mathf.MoveTowards(raise, sleeper && turningNow ? coverHeight * (1f - mean) : 0f, Time.deltaTime * 0.4f);
            var upLocal = transform.InverseTransformDirection(Vector3.up);
            for (int k = 0; k < hinges.Length; k++)
            {
                // each band turns over in turn; its wall part goes up the wall as it lands (and comes down first)
                float main = Mathf.SmoothStep(0, 1, BandFold(k));
                // the outer part turns over with the band until it stands upright, then stays upright while the band
                // goes on over: it never swings out over the wall-side edge (the bed stands against the wall)
                float wall = Mathf.Clamp01(2f * main - 1f);
                hinges[k].localRotation = Quaternion.AngleAxis(180f * main, axis);
                // the turn line lifts a little while the band is up, as a hand holds it clear of the bed
                hinges[k].localPosition = hingeRest[k] + upLocal * ((sleeper ? liftSleeper : liftEmpty) * Mathf.Sin(Mathf.PI * main) + raise);
                if (k < wallFolds.Length && wallFolds[k]) wallFolds[k].localRotation = Quaternion.AngleAxis(wallAngle * wall, axis);
            }
            UpdateLimits(mean);
        }

        void LateUpdate()
        {
            var v = cloth.vertices;
            if (grip && gripVertex >= 0 && gripVertex < v.Length) grip.position = transform.TransformPoint(v[gripVertex]);
            if (lyingGrip && lyingGripVertex >= 0 && lyingGripVertex < v.Length) lyingGrip.position = transform.TransformPoint(v[lyingGripVertex]);
        }

        void UpdateLimits(float main)
        {
            bool moving = !Mathf.Approximately(fold, foldTarget);
            if (moving) lastChange = Time.time;
            bool changed = false;
            for (int i = 0; i < limit.Length; i++)
            {
                // while it turns it keeps close to its arc (over a sleeper too, or it would fall behind the body and
                // stay there); once over a sleeper it is let go and drops onto them
                // (the sleeper's limits fit the quilt lying over the body: folded back, it is held close again)
                // (while turning, it sags most in the middle of the arc and comes in to land close to its pose, so it
                // does not drop into the mattress as it lands)
                float swing = Mathf.Sin(Mathf.PI * main);
                float want = moving ? Mathf.Lerp(settled, turning, swing) : sleeper && fold < 0.02f ? sleeperLimit[i] : settled;
                if (!moving && fold > 0.98f && isWallPart[i]) want += slump;
                if (isOverhang[i]) want += overhangExtra;
                float now = limit[i];
                float next = want > now ? want : Mathf.MoveTowards(now, want, tighten * Time.deltaTime);
                if (!Mathf.Approximately(next, now)) { limit[i] = next; coeffs[i].maxDistance = next; changed = true; }
            }
            if (changed) cloth.coefficients = coeffs;
        }
    }
}
