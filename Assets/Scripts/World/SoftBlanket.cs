using UnityEngine;

namespace AiWorld.World
{
    /// <summary>
    /// A blanket that is real cloth. Its top edge (the row nearest the pillow) is held by an invisible "edge" bone.
    /// Pulling the edge back folds the blanket away so someone can get in, and pulling it up again covers them. The
    /// sleeper's body capsules are cloth colliders, so the blanket lies over the body instead of through it.
    ///
    /// How far each vertex may stray from where the blanket is skinned depends on what it is doing:
    ///  * folding: the edge is held (0) and the rest hangs free;
    ///  * over a sleeper: only the middle of the edge is held, resting on the chest, so the blanket cannot slide off the
    ///    rounded body; the corners of the edge are let go and drape down instead of floating in the air; and the whole
    ///    sheet is kept within ~40 cm of where it lay (enough to rise over the fitted body), so it does not slide off or wander during a night of simulation;
    ///  * on an empty bed: held loosely flat.
    /// The limits change gradually (a sudden limit snaps vertices back), and the edge is taken up again smoothly.
    /// </summary>
    [RequireComponent(typeof(Cloth))]
    public class SoftBlanket : MonoBehaviour
    {
        [Tooltip("the bone that holds the top edge")]
        public Transform edge;
        [Tooltip("where the edge is held while someone gets in or out: high over the feet, so the blanket hangs clear above the legs (local to the bed)")]
        public Vector3 foldedOffset = new Vector3(0, 0.12f, -1.0f);
        public float speed = 0.4f;
        [Tooltip("where the edge rests over a sleeper's chest instead of on the mattress (local to the bed)")]
        public Vector3 coverOffset = new Vector3(0, 0.25f, -0.45f);
        [Tooltip("over a sleeper, the edge comes straight down from the held position to here (over the feet, where the hem just reaches the toes) before it is drawn up to the chest (local, from the rest position)")]
        public Vector3 overFeet = new Vector3(0, 1.9f, -1.5f);

        [Header("How far vertices may move from the skinned pose (m)")]
        public float hangFree = 2.5f;
        public float overSleeper = 0.4f, overSleeperCorners = 0.35f;
        [Tooltip("over a sleeper, the edge is held only this far either side of its middle (m)")]
        public float heldHalfWidth = 0.2f;
        public float onEmptyBed = 0.25f;
        [Tooltip("metres per second at which a limit tightens (it loosens at once)")]
        public float tighten = 0.4f;

        Vector3 restLocal;
        float fold, foldTarget, cover, coverTarget;
        Cloth cloth;
        bool[] isEdge, isHeld;
        float[] limit;
        ClothSkinningCoefficient[] coeffs;

        public float Folded => fold;

        void Awake()
        {
            cloth = GetComponent<Cloth>();
            if (edge) restLocal = edge.localPosition;
            coeffs = cloth.coefficients;
            isEdge = new bool[coeffs.Length];
            isHeld = new bool[coeffs.Length];
            limit = new float[coeffs.Length];
            var verts = GetComponent<SkinnedMeshRenderer>().sharedMesh.vertices;
            for (int i = 0; i < coeffs.Length; i++)
            {
                isEdge[i] = coeffs[i].maxDistance <= 0.0001f;
                // the edge is a straight row through the bone: the held part is the middle of it
                isHeld[i] = isEdge[i] && edge && Vector3.Distance(verts[i], edge.localPosition) < heldHalfWidth;
                limit[i] = coeffs[i].maxDistance;
            }
        }

        /// <summary>loosen or tighten each vertex's limit toward what the blanket is doing now</summary>
        void UpdateLimits()
        {
            bool folding = fold > 0.001f || foldTarget > 0f;
            bool sleeper = !folding && cover > 0.5f;
            bool changed = false;
            for (int i = 0; i < limit.Length; i++)
            {
                float want = folding ? (isEdge[i] ? 0f : hangFree)
                           : sleeper ? (isHeld[i] ? 0f : isEdge[i] ? overSleeperCorners : overSleeper)
                           : (isEdge[i] ? 0f : onEmptyBed);
                float now = limit[i];
                float next = want > now ? want : Mathf.MoveTowards(now, want, tighten * Time.deltaTime);
                if (!Mathf.Approximately(next, now)) { limit[i] = next; coeffs[i].maxDistance = next; changed = true; }
            }
            if (changed) cloth.coefficients = coeffs;
        }

        /// <summary>0 = covering the bed, 1 = folded back to the foot end</summary>
        public void Fold(float amount) => foldTarget = Mathf.Clamp01(amount);

        /// <summary>rest the held edge just on top of a sleeper's chest at this world height (their outfit decides it)</summary>
        public void CoverAt(float chestTopWorldY)
        {
            var parent = edge.parent;
            float now = parent.TransformPoint(restLocal + coverOffset).y;
            coverOffset += parent.InverseTransformVector(Vector3.up * (chestTopWorldY + 0.02f - now));
        }

        /// <summary>someone lies in the bed: the edge comes down over their chest, not through them to the mattress</summary>
        public void Cover(bool sleeper) => coverTarget = sleeper ? 1f : 0f;

        /// <summary>make the cloth collide with these (a sleeper's body); pass null to clear</summary>
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
            if (!edge) return;
            fold = Mathf.MoveTowards(fold, foldTarget, speed * Time.deltaTime);
            // only change where it rests while it is folded away, so the edge never cuts through the sleeper
            if (fold > 0.9f) cover = coverTarget;
            Vector3 p;
            if (cover > 0.5f)
            {
                // someone in the bed: held high over the feet → straight down until the hem reaches the toes → drawn up to
                // the chest, so the cloth comes down onto the legs from above and never sweeps along the mattress under
                // them (lifting it off is the same in reverse)
                var chest = restLocal + coverOffset;
                var feet = restLocal + overFeet;
                float k = Mathf.SmoothStep(0, 1, fold);
                p = k < 0.6f ? Vector3.Lerp(chest, feet, k / 0.6f) : Vector3.Lerp(feet, restLocal + foldedOffset, (k - 0.6f) / 0.4f);
            }
            else
            {
                // an empty bed: lift as it goes, so the edge rolls back over the blanket instead of dragging through it
                p = Vector3.Lerp(restLocal, restLocal + foldedOffset, Mathf.SmoothStep(0, 1, fold));
                p.y += Mathf.Sin(fold * Mathf.PI) * 0.18f;
            }
            edge.localPosition = p;
            UpdateLimits();
        }
    }
}
