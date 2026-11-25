using System;
using System.Collections.Concurrent;
using System.IO;
using System.Linq;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using AiWorld.Agents;
using AiWorld.World;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace AiWorld.Airi
{
    /// <summary>
    /// AIRI in the world: an outside AI (for example the AIRI desktop app, through its MCP settings) lives in the game
    /// as the character Airi and decides for herself; the other characters keep their own brains.
    ///
    ///   AIRI ⇄ MCP ⇄ bridge/airi-mcp.mjs ⇄ WebSocket (127.0.0.1:8789) ⇄ this component
    ///
    /// It connects to the bridge (and keeps trying every 3 s while the bridge is not running), answers the bridge's
    /// requests (status, look, act) and reports what Airi does and thinks as events. While the bridge has an MCP
    /// client, Airi's decisions come from it (<see cref="AiriBrain"/>). It adds itself to the scene at start.
    /// </summary>
    public class AiriLink : MonoBehaviour
    {
        public const string DefaultBridge = "ws://127.0.0.1:8789";

        [Tooltip("the bridge's WebSocket address (bridge/airi-mcp.mjs --ws)")]
        public string url = DefaultBridge;
        [Tooltip("the character AIRI plays")]
        public string characterName = "Airi";
        [Tooltip("real seconds to wait for AIRI's next action before the character's own brain decides once (0: never)")]
        public float autopilotSeconds = 60f;

        public static AiriLink Instance { get; private set; }
        public Agent Character { get; private set; }
        public AiriBrain Brain { get; private set; }

        public string StatusText => !connected ? $"AIRI: waiting for the bridge at {url}"
            : Brain is { Controlled: true } ? $"AIRI: connected, playing {Character.displayName}"
            : "AIRI: bridge connected, no AIRI yet";

        /// <summary>sent from the socket thread to the main thread: a message, or that the connection closed</summary>
        const string Closed = "\u0000closed";
        readonly ConcurrentQueue<string> inbox = new();
        readonly ConcurrentQueue<string> outbox = new();
        readonly SemaphoreSlim outSignal = new(0);
        CancellationTokenSource cts;
        volatile bool connected;
        string lastDoing, lastThought;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Install()
        {
            if (FindAnyObjectByType<AiriLink>()) return;
            if (!FindObjectsByType<Agent>(FindObjectsSortMode.None).Any(a => a.displayName == "Airi")) return;
            new GameObject("AIRI link").AddComponent<AiriLink>();
        }

        void Awake() => Instance = this;

        void Start()
        {
            // a player build can be pointed elsewhere: -airi-bridge ws://127.0.0.1:<port>, -airi-autopilot <seconds>
            var args = Environment.GetCommandLineArgs();
            for (int i = 0; i < args.Length - 1; i++)
            {
                if (args[i] == "-airi-bridge") url = args[i + 1];
                if (args[i] == "-airi-autopilot" && float.TryParse(args[i + 1], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var s)) autopilotSeconds = s;
            }
            Character =FindObjectsByType<Agent>(FindObjectsSortMode.None).FirstOrDefault(a => a.displayName == characterName);
            if (!Character)
            {
                Debug.LogWarning($"[AIRI] no character named {characterName}");
                enabled = false;
                return;
            }
            Brain = new AiriBrain(Character.brain, autopilotSeconds);
            Character.brain = Brain;
            Brain.OnTurn += () => Event("turn", $"your turn to decide (place: {Place(Character)})");
            Brain.OnAutopilot += c => Event("autopilot", c.target
                ? $"you gave no action for {autopilotSeconds:0} s, so {Character.displayName}'s own habits chose: {c.affordance.verb} at {c.target.id} (act with interrupt: true to change it)"
                : $"you gave no action for {autopilotSeconds:0} s, and {Character.displayName}'s own habits found nothing to do");
            cts = new CancellationTokenSource();
            var token = cts.Token;
            Task.Run(() => Run(token));
        }

        void OnDestroy()
        {
            cts?.Cancel();
            if (Instance == this) Instance = null;
        }

        void Update()
        {
            while (inbox.TryDequeue(out var raw))
            {
                if (raw == Closed) { Brain.SetControl(false); continue; }
                JObject msg;
                try { msg = JObject.Parse(raw); } catch { continue; }
                if ((string)msg["type"] == "control") { Brain.SetControl((bool?)msg["on"] ?? false); continue; }
                var id = msg["id"];
                if (id == null) continue;
                try { Send(new JObject { ["id"] = id, ["result"] = Answer((string)msg["method"], msg["params"] as JObject ?? new JObject()) }); }
                catch (Exception e) { Send(new JObject { ["id"] = id, ["error"] = e.Message }); }
            }
            // what Airi starts doing and thinks, as events for wait_for_event
            if (Character.Doing != lastDoing) { lastDoing = Character.Doing; Event("memory", $"now {lastDoing}"); }
            if (Character.Thought != lastThought) { lastThought = Character.Thought; if (lastThought != null) Event("memory", $"thought: {lastThought}"); }
        }

        // ------------------------------------------------------------------ requests

        JToken Answer(string method, JObject p) => method switch
        {
            "status" => Status(),
            "look" => Look(),
            "act" => Act(p),
            _ => throw new Exception($"unknown request {method}"),
        };

        JObject You() => new()
        {
            ["name"] = Character.displayName,
            ["doing"] = Character.Doing,
            ["place"] = Place(Character),
            ["asleep"] = Character.Asleep,
            ["needs"] = new JObject(Character.needs.Select(n => new JProperty(n.Key.ToString().ToLowerInvariant(), Mathf.RoundToInt(n.Value)))),
            ["waitingForYou"] = Brain.Awaiting,
            ["autopilotSeconds"] = Mathf.RoundToInt(autopilotSeconds),
        };

        JObject Status() => new()
        {
            ["game"] = "unity",
            ["time"] = GameClock.Instance ? GameClock.Instance.Clock : "",
            ["you"] = You(),
            ["others"] = new JArray(Others().Select(a => new JObject { ["name"] = a.displayName, ["doing"] = a.Doing, ["place"] = Place(a) })),
            ["gestures"] = new JArray(Character.rig.Live.Gestures.Select(g => new JValue(g))),
            ["emotions"] = new JArray(),
            ["note"] = "Unity version: act can interact (with run: true to run there), say (the words show above your head), wait, and gesture while standing still when the live motion server runs (gestures is then not empty)."
                + (Character.rig.Live.Texts ? " A gesture can also be a motion you describe in English (motion), which the Kimodo motion server makes." : "")
                + " Emotions, speech and small talk are not ported yet.",
        };

        JObject Look()
        {
            float hour = GameClock.Instance ? GameClock.Instance.Hour : 12f;
            return new JObject
            {
                ["you"] = You(),
                ["time"] = GameClock.Instance ? GameClock.Instance.Clock : "",
                ["hour"] = Mathf.Round(hour * 10f) / 10f,
                ["objects"] = new JArray(Interactable.All.Select(it => new JObject
                {
                    ["id"] = it.id,
                    ["kind"] = it.kind,
                    ["verbs"] = new JArray(it.affordances.Where(a => a.OpenAt(hour)).Select(a => a.verb)),
                    ["inUseBy"] = it.User ? it.User.displayName : null,
                    ["inside"] = it.inside,
                })),
                ["others"] = new JArray(Others().Select(a => new JObject
                {
                    ["name"] = a.displayName,
                    ["doing"] = a.Doing,
                    ["distance"] = Mathf.Round(Vector3.Distance(a.transform.position, Character.transform.position) * 10f) / 10f,
                })),
            };
        }

        JObject Act(JObject p)
        {
            if (!Brain.Controlled) throw new Exception($"{Character.displayName} is not under your control (the bridge has no MCP client)");
            string Str(string k) => p[k]?.Type == JTokenType.String && !string.IsNullOrWhiteSpace((string)p[k]) ? ((string)p[k]).Trim() : null;
            bool interrupt = p["interrupt"]?.Type == JTokenType.Boolean && (bool)p["interrupt"];
            string thought = Str("thought");
            switch (Str("type"))
            {
                case "interact":
                {
                    string objectId = Str("object"), verb = Str("verb");
                    if (objectId == null || verb == null) throw new Exception("interact needs \"object\" and \"verb\" (see look: objects)");
                    var it = Interactable.All.FirstOrDefault(x => x.id == objectId) ?? throw new Exception($"there is no object \"{objectId}\" (see look: objects)");
                    var aff = it.affordances.FirstOrDefault(a => a.verb == verb) ?? throw new Exception($"\"{objectId}\" has no verb \"{verb}\" (it has: {string.Join(", ", it.affordances.Select(a => a.verb))})");
                    if (!aff.OpenAt(GameClock.Instance ? GameClock.Instance.Hour : 12f)) throw new Exception($"\"{verb}\" is not possible at this time of day");
                    if (it.User && it.User != Character) throw new Exception($"{objectId} is in use by {it.User.displayName}");
                    bool now = Brain.Awaiting;
                    if (interrupt && !now) Character.StopActivity();
                    Brain.Queue(new Choice { target = it, affordance = aff, reason = thought, run = p["run"]?.Type == JTokenType.Boolean && (bool)p["run"] });
                    return Accepted(now, interrupt);
                }
                case "say":
                {
                    var text = Str("text") ?? throw new Exception("say needs \"text\"");
                    Character.Say(text);
                    return new JObject { ["accepted"] = "said it (the words show above your head; nobody can hear speech in this version yet)", ["doing"] = Character.Doing };
                }
                case "wait":
                {
                    float minutes = p["minutes"]?.Type is JTokenType.Integer or JTokenType.Float ? (float)p["minutes"] : 0;
                    if (minutes <= 0) throw new Exception("wait needs \"minutes\" (game minutes, 1 to 120)");
                    bool now = Brain.Awaiting;
                    if (interrupt && !now) Character.StopActivity();
                    Brain.WaitFor(Mathf.Clamp(minutes, 1, 120));
                    return Accepted(now, interrupt);
                }
                case "gesture":
                {
                    var gesture = Str("gesture");
                    var motion = gesture == null ? Str("motion") : null;
                    if (gesture == null && motion == null) throw new Exception("gesture needs \"gesture\" (see world_status: gestures) or \"motion\" (a motion described in English)");
                    var live = Character.rig.Live;
                    if (!live.Available) throw new Exception("gestures need the live motion server, which is not running");
                    if (gesture != null && !live.Gestures.Contains(gesture)) throw new Exception($"there is no gesture \"{gesture}\" (there are: {string.Join(", ", live.Gestures)})");
                    if (motion != null && !live.Texts) throw new Exception("a described motion needs the Kimodo motion server: this server plays only the gestures in world_status");
                    if (Brain.HasQueued) throw new Exception($"{Character.displayName} is about to start the action you gave, so a gesture would be cut short");
                    if (!Character.rig.StandingFree) throw new Exception($"gestures play while standing still, and {Character.displayName} is {Character.Doing}");
                    if (gesture != null)
                    {
                        live.Play(gesture);
                        return new JObject { ["accepted"] = $"playing {gesture}", ["doing"] = Character.Doing };
                    }
                    live.PlayText(motion);
                    return new JObject { ["accepted"] = $"making \"{motion}\": it starts in a few seconds, or in about 30 s for a description the server has not had before", ["doing"] = Character.Doing };
                }
                default:
                    throw new Exception("type must be one of interact, say, gesture, wait");
            }
        }

        JObject Accepted(bool now, bool interrupt) => new()
        {
            ["accepted"] = now ? "doing it now"
                : interrupt ? "stopping the current activity (the body gets up the proper way), then doing it"
                : $"queued: {Character.displayName} is busy ({Character.Doing}); it runs when that ends, or send interrupt: true",
            ["doing"] = Character.Doing,
        };

        Agent[] Others() => FindObjectsByType<Agent>(FindObjectsSortMode.None).Where(a => a != Character).ToArray();

        static string Place(Agent a) => House.Instance && !House.Instance.IsInside(a.transform.position) ? "yard" : "house";

        // ------------------------------------------------------------------ the socket (on a worker thread)

        void Event(string kind, string text)
        {
            if (!connected) return;
            Send(new JObject { ["type"] = "event", ["event"] = new JObject { ["time"] = GameClock.Instance ? GameClock.Instance.Clock : "", ["kind"] = kind, ["text"] = text } });
        }

        void Send(JObject msg)
        {
            if (!connected) return;
            outbox.Enqueue(msg.ToString(Newtonsoft.Json.Formatting.None));
            outSignal.Release();
        }

        async Task Run(CancellationToken stop)
        {
            bool told = false;
            while (!stop.IsCancellationRequested)
            {
                using var ws = new ClientWebSocket();
                using var conn = CancellationTokenSource.CreateLinkedTokenSource(stop);
                try
                {
                    await ws.ConnectAsync(new Uri(url), conn.Token);
                    while (outbox.TryDequeue(out _)) { }   // nothing stale from a previous connection
                    connected = true;
                    told = false;
                    Debug.Log($"[AIRI] connected to the bridge at {url}");
                    _ = SendLoop(ws, conn.Token);
                    var buf = new byte[16 * 1024];
                    using var message = new MemoryStream();
                    while (ws.State == WebSocketState.Open && !stop.IsCancellationRequested)
                    {
                        var r = await ws.ReceiveAsync(new ArraySegment<byte>(buf), conn.Token);
                        if (r.MessageType == WebSocketMessageType.Close) break;
                        message.Write(buf, 0, r.Count);
                        if (!r.EndOfMessage) continue;
                        inbox.Enqueue(Encoding.UTF8.GetString(message.GetBuffer(), 0, (int)message.Length));
                        message.SetLength(0);
                    }
                }
                catch (Exception e) when (!stop.IsCancellationRequested)
                {
                    if (!told) Debug.Log($"[AIRI] no bridge at {url} yet ({e.GetType().Name}); trying again every 3 s");
                    told = true;
                }
                catch { }
                finally
                {
                    if (connected) Debug.Log("[AIRI] the bridge connection closed");
                    connected = false;
                    conn.Cancel();
                    inbox.Enqueue(Closed);
                }
                try { await Task.Delay(3000, stop); } catch { }
            }
        }

        async Task SendLoop(ClientWebSocket ws, CancellationToken token)
        {
            try
            {
                while (!token.IsCancellationRequested && ws.State == WebSocketState.Open)
                {
                    await outSignal.WaitAsync(token);
                    while (outbox.TryDequeue(out var text))
                        await ws.SendAsync(new ArraySegment<byte>(Encoding.UTF8.GetBytes(text)), WebSocketMessageType.Text, true, token);
                }
            }
            catch { }
        }
    }
}
