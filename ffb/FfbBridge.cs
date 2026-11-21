// Force feedback-brygga för Lotus Elise – Stelvio.
// Kompileras av serve.ps1 (Add-Type, C# 5) och körs i serverns process.
//
// Webbläsaren räknar ut krafterna ur bilens fysik och skickar dem via WebSocket (/__ffb).
// Bryggan styr ratten via SDL2 (DirectInput): en konstant kraft (rattmoment), en dämpare
// och en sinusvibration (vägbana/gräs). Allt SDL-arbete sker i en egen tråd.
//
// Protokoll (text, ett kommando per meddelande):
//   webbläsare -> brygga:  "F <kraft -1..1> <dämpning 0..1> <vibration 0..1> <period ms>"
//                          "H <vendor hex> <product hex>"   (vilken ratt som används för styrning)
//                          "S"                              (stoppa alla krafter)
//   brygga -> webbläsare:  "OK <enhetsnamn>" | "WAIT <text>" | "ERR <text>"
// Säkerhet: kommer inget F-kommando på 250 ms nollas alla krafter.

using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace LotusFfb
{
    static class Native
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr LoadLibrary(string path);
        [DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint ms);

        const string L = "SDL2.dll";
        [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern int SDL_SetHint([MarshalAs(UnmanagedType.LPStr)] string name, [MarshalAs(UnmanagedType.LPStr)] string value);
        [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern int SDL_Init(uint flags);
        [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern IntPtr SDL_GetError();
        [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern void SDL_JoystickUpdate();
        [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern int SDL_NumJoysticks();
        [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern IntPtr SDL_JoystickOpen(int index);
        [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern void SDL_JoystickClose(IntPtr joy);
        [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern IntPtr SDL_JoystickName(IntPtr joy);
        [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern ushort SDL_JoystickGetVendor(IntPtr joy);
        [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern ushort SDL_JoystickGetProduct(IntPtr joy);
        [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern int SDL_JoystickGetAttached(IntPtr joy);
        [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern int SDL_JoystickIsHaptic(IntPtr joy);
        [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern IntPtr SDL_HapticOpenFromJoystick(IntPtr joy);
        [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern void SDL_HapticClose(IntPtr h);
        [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern uint SDL_HapticQuery(IntPtr h);
        [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern int SDL_HapticSetGain(IntPtr h, int gain);
        [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern int SDL_HapticSetAutocenter(IntPtr h, int autocenter);
        [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern int SDL_HapticNewEffect(IntPtr h, IntPtr effect);
        [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern int SDL_HapticUpdateEffect(IntPtr h, int id, IntPtr effect);
        [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern int SDL_HapticRunEffect(IntPtr h, int id, uint iterations);
        [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern int SDL_HapticStopAll(IntPtr h);

        public const uint INIT_JOYSTICK = 0x200, INIT_HAPTIC = 0x1000;
        public const ushort CONSTANT = 1 << 0, SINE = 1 << 1, DAMPER = 1 << 8;
        public const uint GAIN = 1 << 12, AUTOCENTER = 1 << 13;
        public const byte DIR_CARTESIAN = 1, DIR_STEERING_AXIS = 3;

        public static string Utf8(IntPtr p)
        {
            if (p == IntPtr.Zero) return "";
            int n = 0; while (Marshal.ReadByte(p, n) != 0) n++;
            byte[] b = new byte[n]; Marshal.Copy(p, b, 0, n);
            return Encoding.UTF8.GetString(b);
        }
        public static string Error() { return Utf8(SDL_GetError()); }
    }

    // SDL_HapticEffect är en union; fälten skrivs direkt på sina byte-offset (SDL2, alla plattformar).
    sealed class Effect : IDisposable
    {
        public readonly IntPtr P = Marshal.AllocHGlobal(128);
        public Effect(ushort type, byte dirType)
        {
            for (int i = 0; i < 128; i++) Marshal.WriteByte(P, i, 0);
            Marshal.WriteInt16(P, 0, (short)type);
            Marshal.WriteByte(P, 4, dirType);          // direction.type
            Marshal.WriteInt32(P, 8, 1);               // direction.dir[0]
            Marshal.WriteInt32(P, 20, -1);             // length = SDL_HAPTIC_INFINITY
        }
        public void I16(int off, int v) { Marshal.WriteInt16(P, off, (short)v); }
        public void Dispose() { Marshal.FreeHGlobal(P); }
    }

    public static class Bridge
    {
        static string dir;
        static volatile string status = "WAIT Startar…";
        static volatile WebSocket client;
        static readonly object sendLock = new object(), wsLock = new object();
        static readonly Stopwatch clock = Stopwatch.StartNew();

        // senaste värden från webbläsaren
        static double tConst, tDamper, tRumble; static int tPeriod = 30;
        static long lastMsgMs = -100000;
        static volatile int wantVid = -1, wantPid = -1;
        static volatile bool rescan;

        public static bool Start(string ffbDir)
        {
            dir = ffbDir;
            string dll = Path.Combine(dir, "SDL2.dll");
            if (!File.Exists(dll)) { status = "ERR SDL2.dll saknas i mappen ffb"; return false; }
            if (Native.LoadLibrary(dll) == IntPtr.Zero)
            {
                status = "ERR SDL2.dll kunde inte laddas (fel " + Marshal.GetLastWin32Error() + (Environment.Is64BitProcess ? ")" : ", PowerShell körs i 32-bitarsläge)");
                return false;
            }
            Thread t = new Thread(SdlLoop);
            t.IsBackground = true; t.Name = "FFB"; t.Priority = ThreadPriority.AboveNormal;
            t.Start();
            return true;
        }
        public static string Status { get { return status; } }

        // ---------------- WebSocket ----------------
        public static void Accept(HttpListenerContext ctx) { Task.Run(() => Handle(ctx)); }

        static async Task Handle(HttpListenerContext ctx)
        {
            WebSocket ws;
            try { ws = (await ctx.AcceptWebSocketAsync(null)).WebSocket; }
            catch { try { ctx.Response.StatusCode = 500; ctx.Response.Close(); } catch { } return; }
            WebSocket old = client; client = ws;
            if (old != null) { try { old.Abort(); } catch { } }
            Log("webbläsaren ansluten");
            Send(ws, status);
            byte[] buf = new byte[512];
            StringBuilder sb = new StringBuilder();
            try
            {
                while (ws.State == WebSocketState.Open)
                {
                    WebSocketReceiveResult r = await ws.ReceiveAsync(new ArraySegment<byte>(buf), CancellationToken.None);
                    if (r.MessageType == WebSocketMessageType.Close) break;
                    sb.Append(Encoding.ASCII.GetString(buf, 0, r.Count));
                    if (!r.EndOfMessage) { if (sb.Length > 4096) sb.Clear(); continue; }
                    OnMessage(sb.ToString()); sb.Clear();
                }
            }
            catch { }
            if (client == ws) { client = null; Zero(); Log("webbläsaren frånkopplad"); }
            try { ws.Dispose(); } catch { }
        }

        static void OnMessage(string m)
        {
            string[] a = m.Split(' ');
            var inv = System.Globalization.CultureInfo.InvariantCulture;
            try
            {
                if (a[0] == "F" && a.Length >= 5)
                {
                    lock (sendLock)
                    {
                        tConst = Clamp(double.Parse(a[1], inv), -1, 1);
                        tDamper = Clamp(double.Parse(a[2], inv), 0, 1);
                        tRumble = Clamp(double.Parse(a[3], inv), 0, 1);
                        tPeriod = (int)Clamp(double.Parse(a[4], inv), 5, 1000);
                        lastMsgMs = clock.ElapsedMilliseconds;
                    }
                }
                else if (a[0] == "H" && a.Length >= 3)
                {
                    int v = Convert.ToInt32(a[1], 16), p = Convert.ToInt32(a[2], 16);
                    if (v != wantVid || p != wantPid) { wantVid = v; wantPid = p; rescan = true; }
                }
                else if (a[0] == "S") Zero();
            }
            catch { }
        }

        static void Zero() { lock (sendLock) { tConst = 0; tDamper = 0; tRumble = 0; lastMsgMs = -100000; } }

        static void Send(WebSocket ws, string s)
        {
            if (ws == null || ws.State != WebSocketState.Open) return;
            byte[] b = Encoding.UTF8.GetBytes(s);
            lock (wsLock)
            {
                try { ws.SendAsync(new ArraySegment<byte>(b), WebSocketMessageType.Text, true, CancellationToken.None).Wait(500); }
                catch { }
            }
        }

        static void SetStatus(string s)
        {
            if (s == status) return;
            status = s; Log(s);
            Send(client, s);
        }

        static void Log(string s) { try { Console.WriteLine("  FFB: " + s); } catch { } }
        static double Clamp(double v, double lo, double hi) { return v < lo ? lo : v > hi ? hi : v; }

        // ---------------- SDL-tråd ----------------
        static IntPtr joy, hap;
        static int vid, pid;
        static Effect eConst, eDamp, eSine;
        static int idConst = -1, idDamp = -1, idSine = -1;
        static int errors;

        static void SdlLoop()
        {
            try
            {
                Native.timeBeginPeriod(1);
                // Ratten ska nås via DirectInput (det är där Thrustmasters drivrutin har force feedback).
                Native.SDL_SetHint("SDL_JOYSTICK_HIDAPI", "0");
                Native.SDL_SetHint("SDL_JOYSTICK_RAWINPUT", "0");
                Native.SDL_SetHint("SDL_XINPUT_ENABLED", "0");
                Native.SDL_SetHint("SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS", "1");
                if (Native.SDL_Init(Native.INIT_JOYSTICK | Native.INIT_HAPTIC) < 0) { SetStatus("ERR SDL kunde inte starta: " + Native.Error()); return; }
            }
            catch (Exception e) { SetStatus("ERR " + e.Message); return; }

            long nextScan = 0, lastT = clock.ElapsedMilliseconds;
            double cConst = 0, cDamp = 0, cRumble = 0;
            int sConst = 1000000, sDamp = -1, sMag = -1, sPer = -1;
            while (true)
            {
                long now = clock.ElapsedMilliseconds;
                double dt = Math.Max(0.0005, (now - lastT) / 1000.0); lastT = now;
                try
                {
                    if (hap != IntPtr.Zero && (rescan || Native.SDL_JoystickGetAttached(joy) == 0 || errors > 25))
                    {
                        if (!rescan) Log("ratten tappades (fel: " + Native.Error() + ")");
                        CloseDevice(); nextScan = now + (rescan ? 0 : 1500);
                        sConst = 1000000; sDamp = sMag = sPer = -1;
                    }
                    rescan = false;
                    if (hap == IntPtr.Zero)
                    {
                        if (now >= nextScan) { Native.SDL_JoystickUpdate(); OpenDevice(); nextScan = now + 2000; }
                        Thread.Sleep(20); continue;
                    }

                    double tc, td, tr; int tp;
                    lock (sendLock)
                    {
                        bool stale = client == null || now - lastMsgMs > 250;
                        tc = stale ? 0 : tConst; td = stale ? 0 : tDamper; tr = stale ? 0 : tRumble; tp = tPeriod;
                    }
                    // mjuk övergång mellan webbläsarens bildrutor (undviker "trappsteg" i kraften)
                    double k = 1 - Math.Exp(-dt / 0.006);
                    cConst += (tc - cConst) * k;
                    cDamp += (td - cDamp) * Math.Min(1, k * 2);
                    cRumble += (tr - cRumble) * Math.Min(1, k * 2);

                    int lvl = (int)Math.Round(cConst * 32767);
                    if (Math.Abs(lvl - sConst) >= 40 || (lvl == 0 && sConst != 0))
                    {
                        eConst.I16(30, lvl);
                        if (Native.SDL_HapticUpdateEffect(hap, idConst, eConst.P) < 0) errors++; else errors = 0;
                        sConst = lvl;
                    }
                    if (idDamp >= 0)
                    {
                        int dc = (int)Math.Round(cDamp * 32767);
                        if (Math.Abs(dc - sDamp) >= 300 || (dc == 0 && sDamp != 0))
                        {
                            for (int i = 0; i < 3; i++) { eDamp.I16(42 + i * 2, dc); eDamp.I16(48 + i * 2, dc); }
                            Native.SDL_HapticUpdateEffect(hap, idDamp, eDamp.P); sDamp = dc;
                        }
                    }
                    if (idSine >= 0)
                    {
                        int mag = (int)Math.Round(cRumble * 32767);
                        if (Math.Abs(mag - sMag) >= 200 || tp != sPer || (mag == 0 && sMag != 0))
                        {
                            eSine.I16(30, tp); eSine.I16(32, mag);
                            Native.SDL_HapticUpdateEffect(hap, idSine, eSine.P); sMag = mag; sPer = tp;
                        }
                    }
                }
                catch (Exception e) { Log("fel: " + e.Message); errors++; }
                Thread.Sleep(2);
            }
        }

        static void OpenDevice()
        {
            int n = Native.SDL_NumJoysticks();
            IntPtr bestJ = IntPtr.Zero, bestH = IntPtr.Zero; int bestScore = -1; string bestName = "";
            for (int i = 0; i < n; i++)
            {
                IntPtr j = Native.SDL_JoystickOpen(i);
                if (j == IntPtr.Zero) continue;
                IntPtr h = Native.SDL_JoystickIsHaptic(j) == 1 ? Native.SDL_HapticOpenFromJoystick(j) : IntPtr.Zero;
                if (h != IntPtr.Zero && (Native.SDL_HapticQuery(h) & Native.CONSTANT) != 0)
                {
                    string name = Native.Utf8(Native.SDL_JoystickName(j));
                    int v = Native.SDL_JoystickGetVendor(j), p = Native.SDL_JoystickGetProduct(j);
                    int score = (v == wantVid && p == wantPid) ? 3 : v == 0x044f ? 2 : name.ToLowerInvariant().Contains("wheel") ? 1 : 0;
                    if (score > bestScore)
                    {
                        if (bestH != IntPtr.Zero) { Native.SDL_HapticClose(bestH); Native.SDL_JoystickClose(bestJ); }
                        bestJ = j; bestH = h; bestScore = score; bestName = name; vid = v; pid = p;
                        continue;
                    }
                }
                if (h != IntPtr.Zero) Native.SDL_HapticClose(h);
                Native.SDL_JoystickClose(j);
            }
            if (bestH == IntPtr.Zero)
            {
                SetStatus("WAIT Ingen ratt med force feedback hittades" + (n > 0 ? " (" + n + " styrenheter utan FFB)" : "") + " – söker…");
                return;
            }
            joy = bestJ; hap = bestH; errors = 0;
            uint q = Native.SDL_HapticQuery(hap);
            if ((q & Native.AUTOCENTER) != 0) Native.SDL_HapticSetAutocenter(hap, 0); // spelet står för centreringen
            if ((q & Native.GAIN) != 0) Native.SDL_HapticSetGain(hap, 100);

            idConst = Create(Native.CONSTANT, out eConst, null);
            if (idConst < 0)
            {
                string err = Native.Error();
                CloseDevice();
                SetStatus("ERR " + bestName + ": kunde inte skapa kraft (" + err + ")");
                return;
            }
            if ((q & Native.DAMPER) != 0)
                idDamp = Create(Native.DAMPER, out eDamp, e => { for (int i = 0; i < 6; i++) e.I16(30 + i * 2, 0xFFFF); });
            if ((q & Native.SINE) != 0)
                idSine = Create(Native.SINE, out eSine, e => e.I16(30, 30));
            SetStatus("OK " + bestName + (idDamp < 0 ? " (utan dämpare)" : "") + (idSine < 0 ? " (utan vibration)" : ""));
        }

        // Skapar och startar en effekt. Provar först "rattaxeln", sedan x-axeln.
        static int Create(ushort type, out Effect eff, Action<Effect> init)
        {
            foreach (byte dt in new byte[] { Native.DIR_STEERING_AXIS, Native.DIR_CARTESIAN })
            {
                Effect e = new Effect(type, dt);
                if (init != null) init(e);
                int id = Native.SDL_HapticNewEffect(hap, e.P);
                if (id >= 0 && Native.SDL_HapticRunEffect(hap, id, 1) >= 0) { eff = e; return id; }
                e.Dispose();
            }
            eff = null; return -1;
        }

        static void CloseDevice()
        {
            if (hap != IntPtr.Zero) { try { Native.SDL_HapticStopAll(hap); } catch { } Native.SDL_HapticClose(hap); }
            if (joy != IntPtr.Zero) Native.SDL_JoystickClose(joy);
            hap = joy = IntPtr.Zero; idConst = idDamp = idSine = -1;
            foreach (Effect e in new[] { eConst, eDamp, eSine }) if (e != null) e.Dispose();
            eConst = eDamp = eSine = null;
        }
    }
}
