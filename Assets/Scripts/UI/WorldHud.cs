using AiWorld.Agents;
using AiWorld.World;
using UnityEngine;
using UnityEngine.InputSystem;

namespace AiWorld.UI
{
    /// <summary>Name tags and thought bubbles over the characters, the clock, and the speed keys (1/2/3).</summary>
    public class WorldHud : MonoBehaviour
    {
        public Agent[] agents;
        GUIStyle tagStyle, bubble, corner;

        void Update()
        {
            var kb = Keyboard.current;
            var clock = GameClock.Instance;
            if (kb == null || clock == null) return;
            if (kb.digit1Key.wasPressedThisFrame) clock.Speed = 1;
            if (kb.digit2Key.wasPressedThisFrame) clock.Speed = 5;
            if (kb.digit3Key.wasPressedThisFrame) clock.Speed = 20;
        }

        void OnGUI()
        {
            tagStyle ??= new GUIStyle(GUI.skin.label) { alignment = TextAnchor.MiddleCenter, fontStyle = FontStyle.Bold, fontSize = 14 };
            bubble ??= new GUIStyle(GUI.skin.box) { alignment = TextAnchor.MiddleCenter, wordWrap = true, fontSize = 13 };
            corner ??= new GUIStyle(GUI.skin.box) { alignment = TextAnchor.UpperLeft, fontSize = 13, richText = true };
            var cam = Camera.main;
            if (!cam) return;
            var info = GameClock.Instance ? $"<b>{GameClock.Instance.Clock}</b>  ×{GameClock.Instance.Speed}\n" : "";
            foreach (var a in agents)
            {
                if (!a) continue;
                info += $"<b>{a.displayName}</b>: {a.Doing}   E{a.needs[Need.Energy]:0} F{a.needs[Need.Fun]:0} K{a.needs[Need.Knowledge]:0} H{a.needs[Need.Hunger]:0}\n";
                var top = a.transform.position + Vector3.up * ((a.rig ? a.rig.Height : 1.6f) + 0.25f);
                var sp = cam.WorldToScreenPoint(top);
                if (sp.z < 0) continue;
                var p = new Vector2(sp.x, Screen.height - sp.y);
                GUI.Label(new Rect(p.x - 60, p.y - 10, 120, 20), a.displayName, tagStyle);
                var line = a.Asleep ? "Zzz…" : a.Thought;
                if (!string.IsNullOrEmpty(line)) GUI.Box(new Rect(p.x - 110, p.y - 56, 220, 40), line, bubble);
            }
            int lines = agents.Length;
            if (Airi.AiriLink.Instance) { info += Airi.AiriLink.Instance.StatusText + "\n"; lines++; }
            GUI.Box(new Rect(10, 10, 560, 46 + 19 * lines), info + "drag: orbit · right-drag: pan · scroll: zoom · F: follow · 1/2/3: speed", corner);
        }
    }
}
