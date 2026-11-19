using System.Collections.Generic;
using System.IO;
using System.Linq;
using AiWorld.Agents;
using AiWorld.UI;
using AiWorld.World;
using Unity.AI.Navigation;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.AI;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

namespace AiWorld.EditorTools
{
    /// <summary>
    /// Builds Assets/Scenes/Room.unity from code: the house, the props from Assets/Art/Props (made by
    /// tools/blender/build_props.py), their joints and cloth, the NavMesh, lighting, the camera and two characters.
    /// The scene is generated, so edit this file rather than the scene, and run AiWorld ▸ Build Room Scene (or
    /// BatchTools.BuildScene from the command line).
    ///
    /// Coordinates: x right, y up, z back. The house spans x -4..4, z -3..3; the front door is in the wall at z = -3
    /// and opens outward into the yard.
    /// </summary>
    public static class SliceSceneBuilder
    {
        public const string ScenePath = "Assets/Scenes/Room.unity";
        const string PropDir = "Assets/Art/Props";
        const string GenDir = "Assets/Art/Generated";
        const int MovableLayer = 8, AgentLayer = 9;
        const float WallH = 2.6f, WallT = 0.15f;

        static readonly Dictionary<string, Material> mats = new();

        [MenuItem("AiWorld/Build Room Scene")]
        public static void Build()
        {
            Directory.CreateDirectory(GenDir);
            EnsureLayers();
            var controller = ClipFactory.Build();
            mats.Clear();

            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            // ---------------------------------------------------------- light, sky, post-processing
            var sunGo = new GameObject("Sun");
            var sun = sunGo.AddComponent<Light>();
            sun.type = LightType.Directional;
            sun.shadows = LightShadows.Soft;
            sun.shadowStrength = 0.85f;
            sunGo.transform.rotation = Quaternion.Euler(50, 210, 0);
            RenderSettings.sun = sun;
            RenderSettings.ambientMode = AmbientMode.Trilight;
            RenderSettings.ambientSkyColor = new Color(0.62f, 0.68f, 0.78f);
            RenderSettings.ambientEquatorColor = new Color(0.55f, 0.52f, 0.48f);
            RenderSettings.ambientGroundColor = new Color(0.3f, 0.27f, 0.24f);
            var sky = new Material(Shader.Find("Skybox/Procedural"));
            sky.SetFloat("_AtmosphereThickness", 0.8f);
            SaveMat(sky, "Sky");
            RenderSettings.skybox = sky;

            var volGo = new GameObject("Post Processing");
            var vol = volGo.AddComponent<Volume>();
            vol.isGlobal = true;
            var profile = ScriptableObject.CreateInstance<VolumeProfile>();
            var tone = profile.Add<Tonemapping>(true);
            tone.mode.Override(TonemappingMode.ACES);
            var bloom = profile.Add<Bloom>(true);
            bloom.intensity.Override(0.25f);
            bloom.threshold.Override(1.1f);
            var color = profile.Add<ColorAdjustments>(true);
            color.postExposure.Override(0.2f);
            color.saturation.Override(8f);
            var vig = profile.Add<Vignette>(true);
            vig.intensity.Override(0.18f);
            AssetDatabase.DeleteAsset($"{GenDir}/RoomProfile.asset");
            AssetDatabase.CreateAsset(profile, $"{GenDir}/RoomProfile.asset");
            vol.sharedProfile = profile;

            var clockGo = new GameObject("Clock");
            var clock = clockGo.AddComponent<GameClock>();
            clock.sun = sun;
            clock.startHour = 19.5f;

            // ---------------------------------------------------------- ground, floor, walls
            var world = new GameObject("World").transform;
            Block("Ground", world, new Vector3(0, -0.06f, -1f), new Vector3(22, 0.1f, 20), Mat("Grass", new Color(0.42f, 0.56f, 0.32f), 0.95f));
            Block("Floor", world, new Vector3(0, -0.02f, 0), new Vector3(8, 0.04f, 6), Mat("Wood Floor", new Color(0.7f, 0.55f, 0.4f), 0.55f));
            Block("Porch", world, new Vector3(0, -0.03f, -3.7f), new Vector3(2.4f, 0.04f, 1.3f), Mat("Stone", new Color(0.66f, 0.64f, 0.6f), 0.8f));
            var rug = Round("Rug", world, new Vector3(0.2f, 0.004f, -0.2f), new Vector3(2.6f, 0.008f, 1.8f), Mat("Rug", new Color(0.78f, 0.5f, 0.42f), 1f));
            Object.DestroyImmediate(rug.GetComponent<Collider>());

            var wallMat = Mat("Wall", new Color(0.93f, 0.9f, 0.84f), 0.9f);
            var trimMat = Mat("Trim", new Color(0.98f, 0.97f, 0.95f), 0.5f);
            Wall("Wall Back", world, new Vector3(0, 0, 3), 8 + WallT, Vector3.forward, wallMat, trimMat);
            Wall("Wall Left", world, new Vector3(-4, 0, 0), 6, Vector3.left, wallMat, trimMat);
            Wall("Wall Right", world, new Vector3(4, 0, 0), 6, Vector3.right, wallMat, trimMat);
            // front wall with the doorway (0.9 m door + 0.06 m frame each side)
            const float gap = 0.51f;
            var front = new GameObject("Wall Front").transform;
            front.SetParent(world);
            front.position = new Vector3(0, 0, -3);
            front.gameObject.AddComponent<WallCutaway>().outward = Vector3.back;
            float seg = (8 + WallT) / 2 - gap;
            Block("Left", front, new Vector3(-gap - seg / 2, WallH / 2, -3), new Vector3(seg, WallH, WallT), wallMat);
            Block("Right", front, new Vector3(gap + seg / 2, WallH / 2, -3), new Vector3(seg, WallH, WallT), wallMat);
            Block("Over Door", front, new Vector3(0, (WallH + 2.11f) / 2, -3), new Vector3(2 * gap, WallH - 2.11f, WallT), wallMat);

            // ---------------------------------------------------------- props
            var houseGo = new GameObject("House");
            var house = houseGo.AddComponent<House>();
            house.frontWallZ = -3f;

            // the front door: its outer face toward the yard (-z), opening outward
            var door = Place("Door", new Vector3(0, 0, -3), Vector3.back, world);
            house.door = Hinge(door, "Door.Hinge.Leaf", Vector3.back, 18f, 92f, carve: true);
            house.door.handleFront = Find(door, "Door.HandleFront");
            house.door.handleBack = Find(door, "Door.HandleBack");
            house.door.spring = 25f;
            house.door.damper = 7f;

            var bed1 = MakeBed("Bed", new Vector3(-3.42f, 0, 1.92f), Vector3.forward, world);
            var bed2 = MakeBed("Bed 2", new Vector3(-2.9f, 0, -2.38f), Vector3.left, world);
            var desk = MakeDesk(new Vector3(1.6f, 0, 2.6f), world);
            var fridge = MakeFridge(new Vector3(3.58f, 0, -0.9f), world);
            var garden = MakeGarden(world);

            // ---------------------------------------------------------- NavMesh
            var nav = new GameObject("NavMesh").AddComponent<NavMeshSurface>();
            nav.collectObjects = CollectObjects.All;
            nav.useGeometry = NavMeshCollectGeometry.PhysicsColliders;
            nav.layerMask = ~((1 << MovableLayer) | (1 << AgentLayer));
            var settings = NavMesh.GetSettingsByID(0);
            nav.agentTypeID = settings.agentTypeID;
            nav.overrideVoxelSize = true;
            nav.voxelSize = 0.05f;
            nav.BuildNavMesh();
            var navPath = $"{GenDir}/RoomNavMesh.asset";
            AssetDatabase.DeleteAsset(navPath);
            AssetDatabase.CreateAsset(nav.navMeshData, navPath);

            // ---------------------------------------------------------- characters
            var airi = MakeAgent("Airi", "Assets/Avatars/User/model.vrm", "Assets/Avatars/vrm1-constraint-twist-sample.vrm",
                new Vector3(0.6f, 0, 0.4f), controller,
                "Curious and cheerful. Loves reading on the computer late at night.");
            var luna = MakeAgent("Luna", "Assets/Avatars/User/model2.vrm", "Assets/Avatars/seed-san.vrm",
                new Vector3(-1.2f, 0, -0.6f), controller,
                "Calm and thoughtful. Goes to bed early and likes fresh air.");

            // ---------------------------------------------------------- camera, HUD
            var camGo = new GameObject("Main Camera") { tag = "MainCamera" };
            var cam = camGo.AddComponent<Camera>();
            cam.fieldOfView = 45;
            cam.nearClipPlane = 0.05f;
            camGo.AddComponent<AudioListener>();
            var camData = camGo.AddComponent<UniversalAdditionalCameraData>();
            camData.renderPostProcessing = true;
            camData.antialiasing = AntialiasingMode.SubpixelMorphologicalAntiAliasing;
            var orbit = camGo.AddComponent<OrbitCamera>();
            orbit.followTargets = new[] { airi.transform, luna.transform };
            var hud = new GameObject("HUD").AddComponent<WorldHud>();
            hud.agents = new[] { airi, luna };

            EditorSceneManager.SaveScene(scene, ScenePath);
            EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
            AssetDatabase.DeleteAsset("Assets/Scenes/SampleScene.unity");
            AssetDatabase.SaveAssets();
            Debug.Log($"[SliceSceneBuilder] wrote {ScenePath}");
        }

        // ================================================================== props

        static GameObject MakeBed(string name, Vector3 at, Vector3 headTo, Transform parent)
        {
            var bed = Place("Bed", at, -headTo, parent, frontPart: null, backPart: "Bed.Headboard");
            bed.name = name;
            var parts = bed.AddComponent<BedParts>();
            parts.mattressTop = 0.52f;
            var it = Interact(bed, name.ToLower().Replace(' ', '_'), "bed",
                new Affordance { verb = "sleep", minutes = 300, pose = World.Pose.Lie, energy = 90, fun = 5 });

            // sit and stand on the side that faces the middle of the room
            var right = Vector3.Cross(Vector3.up, headTo).normalized;          // the bed's right, looking toward the head
            var toMiddle = (-at).normalized;
            var side = Vector3.Dot(right, toMiddle) > 0 ? right : -right;
            var mid = at - headTo * 0.12f;                                       // a bit toward the foot end
            parts.sit = Point(bed, "Sit", mid + side * (0.475f - 0.2f), side);
            parts.side = Point(bed, "Side", mid + side * (0.475f + 0.3f), side);
            parts.lie = Point(bed, "Lie", at - headTo * 0.18f, -headTo);
            it.approach = parts.side;

            // the mattress, as capsules the blanket lies on
            var caps = new List<CapsuleCollider>();
            var capRoot = new GameObject("Mattress Capsules");
            capRoot.transform.SetParent(bed.transform, false);
            capRoot.layer = MovableLayer;
            // wide, overlapping capsules make a nearly flat top (2 cm dips), so the cloth does not sink into the mattress;
            // thin ones along the long edges cover its rounded top corners
            var capSpecs = new (float off, float r)[] { (-0.36f, 0.2f), (-0.18f, 0.2f), (0f, 0.2f), (0.18f, 0.2f), (0.36f, 0.2f), (-0.42f, 0.1f), (0.42f, 0.1f) };
            foreach (var (off, capR) in capSpecs)
            {
                var g = new GameObject("Capsule");
                g.transform.SetParent(capRoot.transform, false);
                g.transform.position = at + right * off + Vector3.up * (parts.mattressTop - capR + (capR < 0.15f ? 0.03f : 0.02f));
                g.transform.rotation = Quaternion.LookRotation(headTo);
                g.layer = MovableLayer;
                var c = g.AddComponent<CapsuleCollider>();
                c.direction = 2;
                c.radius = capR;
                c.height = 2.0f;
                c.isTrigger = true;    // for the cloth only
                caps.Add(c);
            }
            // the wall beside the bed, as far as the cloth is concerned (walls are not cloth colliders): a fat capsule
            // whose surface is the wall's face, so the blanket bunches against the wall instead of hanging through it
            {
                const float wr = 0.4f;
                var g = new GameObject("Wall Stop");
                g.transform.SetParent(capRoot.transform, false);
                g.transform.position = at - side * (0.505f + wr + 0.02f) + Vector3.up * parts.mattressTop;
                g.transform.rotation = Quaternion.LookRotation(headTo);
                g.layer = MovableLayer;
                var c = g.AddComponent<CapsuleCollider>();
                c.direction = 2;
                c.radius = wr;
                c.height = 2.4f;
                c.isTrigger = true;
                caps.Add(c);
            }
            parts.mattress = caps.ToArray();
            parts.blanket = MakeBlanket(bed, headTo, parts.mattress);
            return bed;
        }

        static SoftBlanket MakeBlanket(GameObject bed, Vector3 headTo, CapsuleCollider[] mattress)
        {
            var src = Find(bed, "Bed.Soft.Blanket");
            var mf = src.GetComponent<MeshFilter>();
            var mr = src.GetComponent<MeshRenderer>();
            var mesh = Object.Instantiate(mf.sharedMesh);
            mesh.name = "Blanket";

            // the root bone holds the sheet; the edge bone holds the row of vertices nearest the pillow
            var rootBone = src;
            var edge = new GameObject("Blanket Edge").transform;
            edge.SetParent(rootBone, false);
            var verts = mesh.vertices;
            var headLocal = rootBone.InverseTransformDirection(headTo).normalized;
            float maxAlong = verts.Max(v => Vector3.Dot(v, headLocal));
            var edgeCentre = verts.Where(v => Vector3.Dot(v, headLocal) > maxAlong - 0.01f).Aggregate(Vector3.zero, (a, v) => a + v)
                             / verts.Count(v => Vector3.Dot(v, headLocal) > maxAlong - 0.01f);
            edge.localPosition = edgeCentre;

            var weights = new BoneWeight[verts.Length];
            var coeffs = new ClothSkinningCoefficient[verts.Length];
            for (int i = 0; i < verts.Length; i++)
            {
                bool onEdge = Vector3.Dot(verts[i], headLocal) > maxAlong - 0.03f;
                weights[i] = new BoneWeight { boneIndex0 = onEdge ? 1 : 0, weight0 = 1 };
                coeffs[i] = new ClothSkinningCoefficient { maxDistance = onEdge ? 0f : 2f, collisionSphereDistance = 0f };
            }
            mesh.boneWeights = weights;
            mesh.bindposes = new[] { rootBone.worldToLocalMatrix * rootBone.localToWorldMatrix, edge.worldToLocalMatrix * rootBone.localToWorldMatrix };
            var meshPath = $"{GenDir}/{bed.name} Blanket.asset";
            AssetDatabase.DeleteAsset(meshPath);
            AssetDatabase.CreateAsset(mesh, meshPath);

            var material = mr.sharedMaterial;
            Object.DestroyImmediate(mr);
            Object.DestroyImmediate(mf);
            var smr = src.gameObject.AddComponent<SkinnedMeshRenderer>();
            smr.sharedMesh = mesh;
            smr.bones = new[] { rootBone, edge };
            smr.rootBone = rootBone;
            var dbl = new Material(Shader.Find("Universal Render Pipeline/Lit"));
            dbl.SetColor("_BaseColor", material.HasProperty("_BaseColor") ? material.GetColor("_BaseColor") : new Color(0.42f, 0.55f, 0.75f));
            dbl.SetFloat("_Smoothness", 0.05f);
            dbl.SetFloat("_Cull", 0f);    // both faces: the blanket folds over
            SaveMat(dbl, $"{bed.name} Blanket");
            smr.sharedMaterial = dbl;
            smr.updateWhenOffscreen = true;

            var cloth = src.gameObject.AddComponent<Cloth>();
            cloth.coefficients = coeffs;
            cloth.stretchingStiffness = 0.9f;
            cloth.bendingStiffness = 0.15f;
            cloth.damping = 0.25f;
            cloth.friction = 0.6f;
            cloth.useGravity = true;
            cloth.worldVelocityScale = 0f;
            cloth.worldAccelerationScale = 0f;
            cloth.clothSolverFrequency = 180;
            cloth.capsuleColliders = mattress;

            var b = src.gameObject.AddComponent<SoftBlanket>();
            b.edge = edge;
            // held up and back past the foot end, so the blanket hangs clear of the mattress while someone gets in or out
            // (the blanket is 1.75 m long and stretches a little: held 2.7 m up over the feet, it hangs clear above the legs)
            b.foldedOffset = rootBone.InverseTransformDirection(-headTo) * 1.5f + rootBone.InverseTransformDirection(Vector3.up) * 2.7f;
            b.overFeet = rootBone.InverseTransformDirection(-headTo) * 1.5f + rootBone.InverseTransformDirection(Vector3.up) * 1.95f;
            b.coverOffset = rootBone.InverseTransformDirection(-headTo) * 0.18f + rootBone.InverseTransformDirection(Vector3.up) * 0.2f;   // on the upper chest
            src.gameObject.layer = MovableLayer;
            return b;
        }

        static GameObject MakeDesk(Vector3 at, Transform parent)
        {
            // the desk's back (its rail) against the back wall; the chair in front, facing it
            var desk = Place("Desk", at, Vector3.back, parent, backPart: "Desk.Rail");
            // the chair stands pushed in, its seat partly under the desk top
            var chairIn = at + Vector3.back * 0.45f;
            var chair = Place("Chair", chairIn, Vector3.forward, parent, backPart: "Chair.Back");
            var laptop = Place("Laptop", at + Vector3.back * 0.1f + Vector3.up * 0.74f, Vector3.back, parent, backPart: "Laptop.Hinge.Lid.X");
            laptop.transform.SetParent(desk.transform, true);
            chair.transform.SetParent(desk.transform, true);

            var parts = desk.AddComponent<DeskParts>();
            var lidT = Find(laptop, "Laptop.Hinge.Lid.X");
            parts.lid = Hinge(laptop, "Laptop.Hinge.Lid.X", Vector3.up, 0.35f, 110f, axisX: true);
            parts.lid.spring = 30f;
            parts.lid.damper = 6f;
            parts.lid.latchSpring = 60f;
            var screen = Find(laptop, "Laptop.Lid.Screen");
            parts.screen = screen;
            var glow = new Material(Shader.Find("Universal Render Pipeline/Lit"));
            glow.SetColor("_BaseColor", new Color(0.1f, 0.15f, 0.2f));
            glow.EnableKeyword("_EMISSION");
            glow.SetColor("_EmissionColor", new Color(0.55f, 0.75f, 1f) * 1.6f);
            SaveMat(glow, "Laptop Screen On");
            screen.GetComponent<Renderer>().sharedMaterial = glow;
            parts.lid.onWhileOpen = screen.gameObject;
            // the lid's front edge, where a finger lifts it: opposite the hinge
            var lidBounds = Bounds(lidT);
            var edge = new GameObject("Lid Edge").transform;
            edge.SetParent(lidT, false);
            edge.position = lidBounds.center + (lidBounds.center - lidT.position).normalized * lidBounds.extents.z * 0.9f;
            parts.lidEdge = edge;

            parts.seatTop = 0.49f;
            parts.chair = MakeSlidingChair(chair, chairIn);
            var chairOut = chairIn + Vector3.back * parts.chair.outDistance;
            var grip = parts.chair.GripCentre;
            parts.behind = Point(desk, "Behind Chair", grip + Vector3.back * 0.38f, Vector3.forward);
            parts.side = Point(desk, "Beside Chair", new Vector3(at.x + 0.62f, 0, chairOut.z + 0.3f), Vector3.forward);
            parts.stepIn = Point(desk, "Step In", new Vector3(at.x, 0, chairOut.z + 0.42f), Vector3.forward);
            var it = Interact(desk, "desk", "desk",
                new Affordance { verb = "use_computer", minutes = 50, pose = World.Pose.Sit, fun = 25, knowledge = 35, energy = -5 });
            it.approach = parts.behind;
            return desk;
        }

        /// <summary>a chair that slides out from the table and back: a kinematic body that carves the NavMesh</summary>
        static SlidingChair MakeSlidingChair(GameObject chair, Vector3 at)
        {
            foreach (var t in chair.GetComponentsInChildren<Transform>())
            {
                t.gameObject.isStatic = false;
                t.gameObject.layer = MovableLayer;     // left out of the NavMesh bake; it carves instead
            }
            foreach (var mc in chair.GetComponentsInChildren<MeshCollider>()) mc.convex = true;
            chair.AddComponent<Rigidbody>().isKinematic = true;
            var lb = LocalBounds(chair.transform);
            var obs = chair.AddComponent<NavMeshObstacle>();
            obs.shape = NavMeshObstacleShape.Box;
            obs.center = lb.center;
            obs.size = lb.size;
            obs.carving = true;
            obs.carveOnlyStationary = true;
            obs.carvingTimeToStationary = 0.2f;

            var sc = chair.AddComponent<SlidingChair>();
            sc.inPosition = at;
            sc.outDirection = Vector3.back;
            sc.outDistance = 0.55f;
            var back = Bounds(Find(chair, "Chair.Back"));
            var top = new Vector3(back.center.x, back.max.y - 0.03f, back.center.z);
            sc.gripLeft = new GameObject("Grip Left").transform;
            sc.gripLeft.SetParent(chair.transform, false);
            sc.gripLeft.position = top + Vector3.left * 0.15f;
            sc.gripRight = new GameObject("Grip Right").transform;
            sc.gripRight.SetParent(chair.transform, false);
            sc.gripRight.position = top + Vector3.right * 0.15f;
            sc.seat = new GameObject("Seat").transform;
            sc.seat.SetParent(chair.transform, false);
            sc.seat.SetPositionAndRotation(new Vector3(at.x, 0, at.z), Quaternion.LookRotation(Vector3.forward));
            return sc;
        }

        static GameObject MakeFridge(Vector3 at, Transform parent)
        {
            var fridge = Place("Fridge", at, Vector3.left, parent, frontPart: "Fridge.Hinge.Door");
            var parts = fridge.AddComponent<FridgeParts>();
            parts.door = Hinge(fridge, "Fridge.Hinge.Door", Vector3.left, 6f, 105f, carve: true);
            parts.door.spring = 18f;
            parts.door.damper = 3.5f;
            parts.door.latchAngle = 10f;
            parts.door.latchSpring = 120f;
            parts.door.handleFront = Find(fridge, "Fridge.Door.Handle");
            var doorT = parts.door.transform;

            // a light inside that comes on while the door is open
            var lightGo = new GameObject("Fridge Light");
            lightGo.transform.SetParent(fridge.transform, false);
            lightGo.transform.position = at + Vector3.up * 1.55f + Vector3.left * 0.1f;
            var l = lightGo.AddComponent<Light>();
            l.type = LightType.Point;
            l.range = 1.6f;
            l.intensity = 1.2f;
            l.color = new Color(0.9f, 0.95f, 1f);
            parts.door.onWhileOpen = lightGo;

            parts.shelf = Find(fridge, "Fridge.Milk");
            var handle = parts.door.handleFront.position;
            var hingeToHandle = Flat(handle - doorT.position).normalized;
            var push = new GameObject("Push Point").transform;
            push.SetParent(doorT, false);
            push.position = handle + Vector3.left * 0.03f + Vector3.down * 0.15f;
            parts.pushPoint = push;
            // stand in front, to the handle side, clear of the door's swing
            parts.front = Point(fridge, "Front", Flat(handle) + Vector3.left * 0.55f + hingeToHandle * 0.25f, Vector3.right);
            var it = Interact(fridge, "fridge", "fridge",
                new Affordance { verb = "eat", minutes = 12, pose = World.Pose.Stand, hunger = 50, fun = 5 });
            it.approach = parts.front;
            return fridge;
        }

        static GameObject MakeGarden(Transform parent)
        {
            var g = new GameObject("Garden");
            g.transform.SetParent(parent);
            g.transform.position = new Vector3(2.2f, 0, -5.6f);
            var leaf = Mat("Leaves", new Color(0.3f, 0.5f, 0.25f), 0.9f);
            var bark = Mat("Bark", new Color(0.4f, 0.3f, 0.22f), 0.9f);
            var looks = new List<Transform>();
            foreach (var p in new[] { new Vector3(-3.5f, 0, -6.5f), new Vector3(4.5f, 0, -7.5f), new Vector3(6f, 0, -4f), new Vector3(-6f, 0, -4.5f) })
            {
                var t = new GameObject("Tree").transform;
                t.SetParent(g.transform);
                t.position = p;
                var trunk = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
                trunk.transform.SetParent(t, false);
                trunk.transform.localPosition = Vector3.up * 0.9f;
                trunk.transform.localScale = new Vector3(0.25f, 0.9f, 0.25f);
                trunk.GetComponent<Renderer>().sharedMaterial = bark;
                trunk.isStatic = true;
                for (int i = 0; i < 3; i++)
                {
                    var crown = GameObject.CreatePrimitive(PrimitiveType.Sphere);
                    crown.transform.SetParent(t, false);
                    crown.transform.localPosition = new Vector3((i - 1) * 0.35f, 2.1f + (i % 2) * 0.35f, (i % 2) * 0.25f);
                    crown.transform.localScale = Vector3.one * (1.3f - i * 0.15f);
                    crown.GetComponent<Renderer>().sharedMaterial = leaf;
                    Object.DestroyImmediate(crown.GetComponent<Collider>());
                }
                looks.Add(t);
            }
            var spot = g.AddComponent<SpotParts>();
            spot.lookPoints = looks.Select(t => { var p = new GameObject("Look").transform; p.SetParent(t, false); p.localPosition = Vector3.up * 2f; return p; }).ToArray();
            var it = Interact(g, "garden", "garden",
                new Affordance { verb = "get_air", minutes = 25, pose = World.Pose.Stand, fun = 20, energy = 5 });
            it.inside = false;
            it.approach = Point(g, "Stand", g.transform.position, Vector3.back);
            return g;
        }

        // ================================================================== characters

        static Agent MakeAgent(string name, string preferred, string fallback, Vector3 at, RuntimeAnimatorController controller, string persona)
        {
            var path = File.Exists(preferred) ? preferred : fallback;
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
            var root = new GameObject(name);
            root.transform.position = at;
            root.layer = AgentLayer;
            var model = (GameObject)PrefabUtility.InstantiatePrefab(prefab, root.transform);
            model.name = "Model";
            model.transform.localPosition = Vector3.zero;
            model.transform.localRotation = Quaternion.identity;
            foreach (var t in model.GetComponentsInChildren<Transform>(true)) t.gameObject.layer = AgentLayer;
            var anim = model.GetComponent<Animator>();
            if (!anim || !anim.avatar || !anim.avatar.isHuman) Debug.LogError($"[SliceSceneBuilder] {path} has no humanoid Avatar");
            anim.runtimeAnimatorController = controller;
            var rig = model.AddComponent<AvatarRig>();
            root.AddComponent<NavMeshAgent>();
            var agent = root.AddComponent<Agent>();
            agent.displayName = name;
            agent.persona = persona;
            agent.rig = rig;
            Debug.Log($"[SliceSceneBuilder] {name}: {path}");
            return agent;
        }

        // ================================================================== helpers

        /// <summary>
        /// put a prop from Assets/Art/Props at a point, turned so its front faces <paramref name="facing"/>. Its front is
        /// found from a named part (a part on the front, or one on the back), whichever way the importer turned it.
        /// </summary>
        static GameObject Place(string prop, Vector3 at, Vector3 facing, Transform parent, string frontPart = null, string backPart = null)
        {
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>($"{PropDir}/{prop}.glb");
            var go = (GameObject)PrefabUtility.InstantiatePrefab(prefab, parent);
            PrefabUtility.UnpackPrefabInstance(go, PrefabUnpackMode.Completely, InteractionMode.AutomatedAction);
            go.transform.SetPositionAndRotation(Vector3.zero, Quaternion.identity);
            Vector3 localFront;
            if (prop == "Door") localFront = Flat(Find(go, "Door.HandleFront").position - Find(go, "Door.HandleBack").position);
            else if (frontPart != null) localFront = Flat(Bounds(Find(go, frontPart)).center - Bounds(go.transform).center);
            else localFront = -Flat(Bounds(Find(go, backPart)).center - Bounds(go.transform).center);
            if (backPart != null && prop == "Laptop") localFront = -Flat(Find(go, backPart).position - Bounds(go.transform).center);
            go.transform.rotation = Quaternion.FromToRotation(localFront.normalized, facing.normalized);
            // FromToRotation may tilt when the vectors are opposite; keep it upright
            go.transform.rotation = Quaternion.Euler(0, go.transform.eulerAngles.y, 0);
            go.transform.position = at;
            foreach (var r in go.GetComponentsInChildren<MeshRenderer>())
            {
                if (r.name.Contains(".Hinge.") || r.name.Contains(".Soft.") || IsUnderHinge(r.transform)) continue;
                r.gameObject.AddComponent<MeshCollider>();
                r.gameObject.isStatic = true;
            }
            return go;
        }

        static bool IsUnderHinge(Transform t)
        {
            for (var p = t; p; p = p.parent) if (p.name.Contains(".Hinge.")) return true;
            return false;
        }

        /// <summary>make a named part swing on a hinge at its origin; it opens so its middle moves toward <paramref name="opensToward"/></summary>
        static Hinged Hinge(GameObject prop, string part, Vector3 opensToward, float mass, float angle, bool axisX = false, bool carve = false)
        {
            var t = Find(prop, part);
            t.gameObject.layer = MovableLayer;
            foreach (var c in t.GetComponentsInChildren<Transform>()) c.gameObject.layer = MovableLayer;
            var b = Bounds(t);
            var lb = LocalBounds(t, ownMeshOnly: true);   // the panel itself; handles stick out of it
            var box = t.gameObject.AddComponent<BoxCollider>();
            box.center = lb.center;
            box.size = lb.size * 0.98f;
            var rb = t.gameObject.AddComponent<Rigidbody>();
            rb.mass = mass;
            rb.angularDamping = 0.6f;
            var joint = t.gameObject.AddComponent<HingeJoint>();
            joint.anchor = Vector3.zero;
            var localAxis = axisX ? Vector3.right : t.InverseTransformDirection(Vector3.up).normalized;
            joint.axis = localAxis;
            joint.autoConfigureConnectedAnchor = true;
            // which sign of the angle opens it the right way
            var worldAxis = t.TransformDirection(localAxis);
            var c0 = b.center - t.position;
            var c1 = Quaternion.AngleAxis(60f, worldAxis) * c0;
            float sign = Vector3.Dot(c1 - c0, opensToward) > 0 ? 1f : -1f;
            var h = t.gameObject.AddComponent<Hinged>();
            h.openAngle = angle * sign;
            if (carve)
            {
                var obs = t.gameObject.AddComponent<NavMeshObstacle>();
                obs.shape = NavMeshObstacleShape.Box;
                obs.center = box.center;
                obs.size = box.size;
                obs.carving = true;
                obs.carveOnlyStationary = true;
                obs.carvingMoveThreshold = 0.05f;
                obs.carvingTimeToStationary = 0.3f;
            }
            Debug.Log($"[SliceSceneBuilder] hinge {part}: open angle {h.openAngle}");
            return h;
        }

        static Interactable Interact(GameObject go, string id, string kind, params Affordance[] affs)
        {
            var it = go.AddComponent<Interactable>();
            it.id = id;
            it.kind = kind;
            it.affordances = affs.ToList();
            return it;
        }

        static Transform Point(GameObject parent, string name, Vector3 at, Vector3 facing)
        {
            var t = new GameObject(name).transform;
            t.SetParent(parent.transform, false);
            t.SetPositionAndRotation(new Vector3(at.x, 0, at.z), Quaternion.LookRotation(Flat(facing).normalized));
            return t;
        }

        static Transform Find(GameObject go, string name) => Find(go.transform, name);

        static Transform Find(Transform t, string name)
        {
            var r = t.GetComponentsInChildren<Transform>(true).FirstOrDefault(c => c.name == name);
            if (!r) throw new System.Exception($"{t.name} has no part named {name}: " + string.Join(", ", t.GetComponentsInChildren<Transform>(true).Select(c => c.name)));
            return r;
        }

        /// <summary>world-space box round a part and its children, from the mesh vertices (renderer bounds can be stale in the editor)</summary>
        static Bounds Bounds(Transform t)
        {
            var mfs = t.GetComponentsInChildren<MeshFilter>();
            if (mfs.Length == 0) return new Bounds(t.position, Vector3.zero);
            var b = new Bounds(mfs[0].transform.TransformPoint(mfs[0].sharedMesh.vertices[0]), Vector3.zero);
            foreach (var mf in mfs)
                foreach (var v in mf.sharedMesh.vertices) b.Encapsulate(mf.transform.TransformPoint(v));
            return b;
        }

        /// <summary>a box round a part and its children in the part's own space</summary>
        static Bounds LocalBounds(Transform t, bool ownMeshOnly = false)
        {
            var mfs = ownMeshOnly ? t.GetComponents<MeshFilter>() : t.GetComponentsInChildren<MeshFilter>();
            var b = new Bounds(t.InverseTransformPoint(mfs[0].transform.TransformPoint(mfs[0].sharedMesh.vertices[0])), Vector3.zero);
            foreach (var mf in mfs)
                foreach (var v in mf.sharedMesh.vertices) b.Encapsulate(t.InverseTransformPoint(mf.transform.TransformPoint(v)));
            return b;
        }

        static Vector3 Flat(Vector3 v) => new(v.x, 0, v.z);

        static GameObject Block(string name, Transform parent, Vector3 center, Vector3 size, Material m)
        {
            var g = GameObject.CreatePrimitive(PrimitiveType.Cube);
            g.name = name;
            g.transform.SetParent(parent, false);
            g.transform.position = center;
            g.transform.localScale = size;
            g.GetComponent<Renderer>().sharedMaterial = m;
            g.isStatic = true;
            return g;
        }

        static GameObject Round(string name, Transform parent, Vector3 center, Vector3 size, Material m)
        {
            var g = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
            g.name = name;
            g.transform.SetParent(parent, false);
            g.transform.position = center;
            g.transform.localScale = new Vector3(size.x, size.y / 2f, size.z);
            g.GetComponent<Renderer>().sharedMaterial = m;
            g.isStatic = true;
            return g;
        }

        /// <summary>a wall with a skirting board, centred at <paramref name="at"/> on the floor</summary>
        static void Wall(string name, Transform parent, Vector3 at, float length, Vector3 outward, Material wall, Material trim)
        {
            var w = new GameObject(name).transform;
            w.SetParent(parent);
            w.position = at;
            bool alongX = Mathf.Abs(outward.z) > 0.5f;
            var size = alongX ? new Vector3(length, WallH, WallT) : new Vector3(WallT, WallH, length);
            Block("Wall", w, at + Vector3.up * WallH / 2, size, wall);
            var skirt = alongX ? new Vector3(length - WallT, 0.1f, 0.02f) : new Vector3(0.02f, 0.1f, length - WallT);
            Block("Skirting", w, at + Vector3.up * 0.05f - outward * (WallT / 2 + 0.01f), skirt, trim);
            w.gameObject.AddComponent<WallCutaway>().outward = outward;
        }

        static Material Mat(string name, Color c, float rough)
        {
            if (mats.TryGetValue(name, out var m)) return m;
            m = new Material(Shader.Find("Universal Render Pipeline/Lit"));
            m.SetColor("_BaseColor", c);
            m.SetFloat("_Smoothness", 1f - rough);
            SaveMat(m, name);
            mats[name] = m;
            return m;
        }

        static void SaveMat(Material m, string name)
        {
            var p = $"{GenDir}/{name}.mat";
            AssetDatabase.DeleteAsset(p);
            AssetDatabase.CreateAsset(m, p);
        }

        static void EnsureLayers()
        {
            var tm = new SerializedObject(AssetDatabase.LoadAllAssetsAtPath("ProjectSettings/TagManager.asset")[0]);
            var layers = tm.FindProperty("layers");
            layers.GetArrayElementAtIndex(MovableLayer).stringValue = "Movable";
            layers.GetArrayElementAtIndex(AgentLayer).stringValue = "Agent";
            tm.ApplyModifiedProperties();
            // characters walk through each other's colliders (the NavMesh keeps them apart); doors still stop against them
            Physics.IgnoreLayerCollision(AgentLayer, AgentLayer, true);
        }
    }
}
