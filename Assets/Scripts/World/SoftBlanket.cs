using UnityEngine;

namespace AiWorld.World
{
    /// <summary>
    /// A quilt that is real cloth. It is turned back the way a person does it by hand: the half nearest the room is
    /// taken by its edge (<see cref="grip"/>) and laid over onto the half by the wall, and the part that does not fit
    /// leans up against the wall. Laying it back covers whoever lies in the bed. The quilt never leaves the bed.
    ///
    /// The cloth follows a skinned pose on three bones: the bed (the far half), <see cref="hinge"/> (the near half,
    /// which turns over about a line just past where a sleeper lies) and <see cref="wallFold"/> (the part that leans
    /// on the wall). How far each vertex may stray from that pose depends on what the quilt is doing:
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
        [Tooltip("turns the near half over (child of the blanket)")]
        public Transform hinge;
        [Tooltip("the part past the wall-side edge of the mattress once folded: it leans up the wall (child of the hinge)")]
        public Transform wallFold;
        [Tooltip("where a hand takes the quilt to turn it back: on the near edge (child of the wall fold)")]
        public Transform grip;
        [Tooltip("the axis both folds turn about, in the hinge's space")]
        public Vector3 axis = Vector3.forward;
        [Tooltip("how far the wall part turns up, once the quilt is over")]
        public float wallAngle = -90f;
        [Tooltip("how high the turn line rises half way through a turn, so the quilt goes over a sleeper, not through (m)")]
        public float liftEmpty = 0.3f, liftSleeper = 0.45f;
        [Tooltip("over a sleeper, the near half is laid down from this high over the mattress and drapes onto the body (m)")]
        public float coverHeight = 0.4f;
        [Tooltip("seconds to turn it back or lay it over")]
        public float seconds = 1.6f;

        [Header("How far vertices may move from the skinned pose (m)")]
        public float settled = 0.1f;
        public float turning = 0.16f;
        [Tooltip("over a sleeper, how much higher than the body under it a vertex may rise (m)")]
        public float overBody = 0.07f;
        [Tooltip("for vertices past the mattress (the overhang): this much more, so it hangs down the side")]
        public float overhangExtra = 0.25f;
        [Tooltip("metres per second at which a limit tightens (it loosens at once)")]
        public float tighten = 0.3f;
        [Tooltip("which vertices are over the mattress: half size (x across, y along) and centre, in the blanket's space")]
        public Vector2 mattressHalf = new(0.475f, 1.025f);
        public Vector3 mattressCentre;
        public Vector3 acrossLocal = Vector3.right, alongLocal = Vector3.forward;

        float fold, foldTarget;
        Vector3 hingeRest;
        float raise;
        bool sleeper;
        Cloth cloth;
        bool[] isOverhang;
        float[] limit, sleeperLimit;
        ClothSkinningCoefficient[] coeffs;

        /// <summary>0 = covering the bed, 1 = turned back to the wall</summary>
        public float Folded => fold;

        void Awake()
        {
            cloth = GetComponent<Cloth>();
            if (hinge) hingeRest = hinge.localPosition;
            coeffs = cloth.coefficients;
            isOverhang = new bool[coeffs.Length];
            limit = new float[coeffs.Length];
            sleeperLimit = new float[coeffs.Length];
            var verts = GetComponent<SkinnedMeshRenderer>().sharedMesh.vertices;
            for (int i = 0; i < coeffs.Length; i++)
            {
                var d = verts[i] - mattressCentre;
                isOverhang[i] = Mathf.Abs(Vector3.Dot(d, acrossLocal)) > mattressHalf.x || Mathf.Abs(Vector3.Dot(d, alongLocal)) > mattressHalf.y;
                limit[i] = coeffs[i].maxDistance;
            }
        }

        /// <summary>turn the quilt back (1) or lay it over the bed (0)</summary>
        public void Fold(float amount) => foldTarget = Mathf.Clamp01(amount);

        /// <summary>
        /// someone lies in the bed (pass their cloth capsules as they lie), or got up (false). Each vertex may then rise
        /// only as high as the body is under it, plus a little: the quilt rests on the body and drapes down beside
        /// it, and it cannot slide off the rounded body during the night.
        /// </summary>
        public void Sleeper(bool on, CapsuleCollider[] body = null)
        {
            sleeper = on;
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
                    if (d >= c.radius) continue;
                    top = Mathf.Max(top, p.y + Mathf.Sqrt(c.radius * c.radius - d * d) - w.y);
                }
                sleeperLimit[i] = Mathf.Max(settled, top + overBody);
            }
        }

        /// <summary>make the cloth collide with these (a sleeper's body) as well as the mattress; pass null to clear</summary>
        public void SetBodyColliders(CapsuleCollider[] body, CapsuleCollider[] mattress)
        {
            int n = (body?.Length ?? 0) + (mattress?.Length ?? 0);
            var all = new CapsuleCollider[n];
            int i = 0;
            if (mattress != null) foreach (var c in mattress) all[i++] = c;
            if (body != null) foreach (var c in body) all[i++] = c;
            cloth.capsuleColliders = all;
        }

        void Update()
        {
            if (!hinge) return;
            fold = Mathf.MoveTowards(fold, foldTarget, Time.deltaTime / Mathf.Max(seconds, 0.01f));
            // the near half turns over first; the wall part goes up the wall as it lands (and comes down first)
            float main = Mathf.SmoothStep(0, 1, Mathf.Clamp01(fold / 0.75f));
            float wall = Mathf.SmoothStep(0, 1, Mathf.Clamp01((fold - 0.6f) / 0.4f));
            hinge.localRotation = Quaternion.AngleAxis(180f * main, axis);
            // the turn line itself lifts while the quilt is up, like a pair of hands shaking it out over the bed
            // over a sleeper the near half ends up held above the body, not flat on the mattress through it, and
            // falls the last bit onto them with its weight
            // (once it has landed, that hold comes down to the bed, and each vertex rests on whatever is under it)
            bool turningNow = !Mathf.Approximately(fold, foldTarget);
            raise = Mathf.MoveTowards(raise, sleeper && turningNow ? coverHeight * (1f - main) : 0f, Time.deltaTime * 0.4f);
            var upLocal = hinge.parent.InverseTransformDirection(Vector3.up);
            hinge.localPosition = hingeRest + upLocal * ((sleeper ? liftSleeper : liftEmpty) * Mathf.Sin(Mathf.PI * main) + raise);
            if (wallFold) wallFold.localRotation = Quaternion.AngleAxis(wallAngle * wall, axis);
            UpdateLimits();
        }

        void UpdateLimits()
        {
            bool moving = !Mathf.Approximately(fold, foldTarget);
            bool changed = false;
            for (int i = 0; i < limit.Length; i++)
            {
                // while it turns it keeps close to its arc (over a sleeper too, or it would fall behind the body and
                // stay there); once over a sleeper it is let go and drops onto them
                float want = moving ? turning : sleeper ? sleeperLimit[i] : settled;
                if (isOverhang[i]) want += overhangExtra;
                float now = limit[i];
                float next = want > now ? want : Mathf.MoveTowards(now, want, tighten * Time.deltaTime);
                if (!Mathf.Approximately(next, now)) { limit[i] = next; coeffs[i].maxDistance = next; changed = true; }
            }
            if (changed) cloth.coefficients = coeffs;
        }
    }
}
