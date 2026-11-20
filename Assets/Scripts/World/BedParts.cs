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
        [Tooltip("sitting with the legs out along the bed: the sitting place, facing the foot end")]
        public Transform swing;
        [Tooltip("lying: position under the hips, facing the foot end")]
        public Transform lie;
        public float mattressTop = 0.52f;
        public SoftBlanket blanket;
        public CapsuleCollider[] mattress;
    }
}
