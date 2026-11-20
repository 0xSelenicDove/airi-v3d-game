using UnityEngine;

namespace AiWorld.World
{
    /// <summary>A fridge whose door swings on a hinge.</summary>
    public class FridgeParts : MonoBehaviour
    {
        [Tooltip("stand here facing the fridge, clear of the door's swing")]
        public Transform front;
        public Hinged door;
        [Tooltip("a point inside, on a shelf, to reach for")]
        public Transform shelf;
        [Tooltip("the outside of the door near its free edge, to push it shut")]
        public Transform pushPoint;
    }
}
