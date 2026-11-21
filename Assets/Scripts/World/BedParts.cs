using UnityEngine;

namespace AiWorld.World
{
    /// <summary>Points and parts a routine needs on a bed; set up by the scene builder.</summary>
    public class BedParts : MonoBehaviour
    {
        [Tooltip("stand here, back to the bed, before sitting on its edge")]
        public Transform side;
        [Tooltip("sitting on the edge: position and facing")]
        public Transform sit;
        [Tooltip("lying: position under the hips, facing the foot end")]
        public Transform lie;
        public float mattressTop = 0.52f;
        [Tooltip("half the mattress's width (x) and length (z), in the bed's space")]
        public Vector2 mattressHalf = new(0.475f, 1.025f);
        public SoftBlanket blanket;
        public CapsuleCollider[] mattress;
    }
}
