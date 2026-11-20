using UnityEngine;

namespace AiWorld.World
{
    /// <summary>
    /// The house: which side of its front wall a point is on, and its front door. Trips between the inside and the
    /// outside go through the door (see Agent.PassDoor); every other trip is plain NavMesh walking.
    /// </summary>
    public class House : MonoBehaviour
    {
        public static House Instance { get; private set; }

        [Tooltip("world z of the front wall; the inside is at larger z")]
        public float frontWallZ = -3f;
        public Hinged door;
        [Tooltip("how far from the leaf a person stands while walking with the door (m)")]
        public float standOff = 0.42f;

        void Awake() => Instance = this;

        public bool IsInside(Vector3 p) => p.z > frontWallZ;

        /// <summary>the handle on one face of the door: outer = the face toward the yard when the door is shut</summary>
        public Transform Handle(bool outer) => outer ? door.handleFront : door.handleBack;

        /// <summary>the horizontal normal of a face of the leaf, as it is now</summary>
        public Vector3 FaceNormal(bool outer)
        {
            var d = door.handleFront.position - door.handleBack.position;
            d.y = 0;
            d.Normalize();
            return outer ? d : -d;
        }

        /// <summary>where a person stands to hold that handle with the door at its current angle</summary>
        public Vector3 HoldPoint(bool outer)
        {
            var p = Handle(outer).position + FaceNormal(outer) * standOff;
            p.y = 0;
            return p;
        }
    }
}
