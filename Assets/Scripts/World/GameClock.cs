using UnityEngine;

namespace AiWorld.World
{
    /// <summary>The world's time of day. One real second is one game minute at speed 1 (keys 1/2/3 change the speed).</summary>
    public class GameClock : MonoBehaviour
    {
        public static GameClock Instance { get; private set; }

        [Tooltip("game hour at start")]
        public float startHour = 18f;
        public float minutesPerSecond = 1f;
        [Tooltip("the sun; it turns with the time of day")]
        public Light sun;

        public float Minutes { get; private set; }
        public float Hour => (Minutes / 60f) % 24f;
        public int Day => (int)(Minutes / 1440f) + 1;
        public float Speed { get; set; } = 1f;

        /// <summary>game minutes that passed this frame</summary>
        public float DeltaMinutes { get; private set; }

        void Awake()
        {
            Instance = this;
            Minutes = startHour * 60f;
        }

        void Update()
        {
            DeltaMinutes = Time.deltaTime * minutesPerSecond * Speed;
            Minutes += DeltaMinutes;
            if (sun)
            {
                // sunrise at 6, noon at 12, sunset at 18; at night the sun is a dim blue moon
                float h = Hour;
                float elev = Mathf.Sin((h - 6f) / 12f * Mathf.PI);
                sun.transform.rotation = Quaternion.Euler(Mathf.Max(elev, 0.15f) * 70f + 5f, 210f + h * 4f, 0);
                float day = Mathf.Clamp01(elev * 3f + 0.2f);
                sun.intensity = Mathf.Lerp(0.15f, 1.3f, day);
                sun.color = Color.Lerp(new Color(0.55f, 0.65f, 1f), new Color(1f, 0.95f, 0.88f), day);
                RenderSettings.ambientIntensity = Mathf.Lerp(0.35f, 1f, day);
            }
        }

        public string Clock => $"Day {Day}  {(int)Hour:00}:{(int)(Minutes % 60):00}";
    }
}
