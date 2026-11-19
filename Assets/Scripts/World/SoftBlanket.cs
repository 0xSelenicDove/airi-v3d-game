using UnityEngine;

namespace AiWorld.World
{
    /// <summary>
    /// A blanket that is real cloth. Its top edge (the row nearest the pillow) is held by an invisible "edge" bone;
    /// the rest hangs free and lies on the mattress. Pulling the edge back folds the blanket down so someone can get
    /// in, and pulling it up again covers them. The sleeper's body capsules are cloth colliders, so the blanket lies
    /// over the body instead of through it.
    /// </summary>
    [RequireComponent(typeof(Cloth))]
    public class SoftBlanket : MonoBehaviour
    {
        [Tooltip("the bone that holds the top edge")]
        public Transform edge;
        [Tooltip("where the edge goes when the blanket is folded back (local to the bed)")]
        public Vector3 foldedOffset = new Vector3(0, 0.12f, -1.0f);
        public float speed = 0.5f;
        [Tooltip("where the edge rests over a sleeper's chest instead of on the mattress (local to the bed)")]
        public Vector3 coverOffset = new Vector3(0, 0.25f, -0.45f);

        Vector3 restLocal;
        float fold, foldTarget, cover, coverTarget;
        Cloth cloth;

        public float Folded => fold;

        void Awake()
        {
            cloth = GetComponent<Cloth>();
            if (edge) restLocal = edge.localPosition;
        }

        /// <summary>0 = covering the bed, 1 = folded back to the foot end</summary>
        public void Fold(float amount) => foldTarget = Mathf.Clamp01(amount);

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
            // lift as it goes, so the edge rolls back over the blanket instead of dragging through it
            float lift = Mathf.Sin(fold * Mathf.PI) * 0.18f;
            var rest = restLocal + coverOffset * cover;
            var p = Vector3.Lerp(rest, restLocal + foldedOffset, Mathf.SmoothStep(0, 1, fold));
            p.y += lift;
            edge.localPosition = p;
        }
    }
}
