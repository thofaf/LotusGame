# Skapar en mittlinje (ai/fast_lane.ai) för banor som saknar en.
# Vägytan (meshar med namn som 1ROAD...) rastreras till ett rutnät, avståndet till vägkanten räknas ut
# och den billigaste vägen från startplatsen (AC_START_0) till målet (AC_AB_FINISH_L/R) söks med en
# kostnad som håller linjen mitt på vägen. Resultatet jämnas ut och skrivs i Assetto Corsas .ai-format.
#
#   powershell -ExecutionPolicy Bypass -File tools\make-ai.ps1 -Track assets\tracks\bg_kakami -Road kakami.kn5 -Markers uhpits.kn5
param(
  [Parameter(Mandatory)][string]$Track,
  [string[]]$Road = @(),
  [Parameter(Mandatory)][string]$Markers,
  [string]$RoadPattern = '^\d+ROAD',
  [double]$Cell = 0.5,
  [string]$Preview = ''
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (-not [IO.Path]::IsPathRooted($Track)) { $Track = Join-Path $root $Track }
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System; using System.IO; using System.Text; using System.Collections.Generic; using System.Text.RegularExpressions;
using System.Drawing;

public class Kn5Geo {
  public List<float[]> Tris = new List<float[]>();            // x0,y0,z0,x1,y1,z1,x2,y2,z2 (AC-koordinater)
  public Dictionary<string, double[]> Points = new Dictionary<string, double[]>(); // AC_-noder: x,y,z
  BinaryReader r; Regex keep;
  string S() { int n = r.ReadInt32(); return Encoding.UTF8.GetString(r.ReadBytes(n)); }

  public void Load(string path, string pattern) {
    keep = pattern == null ? null : new Regex(pattern, RegexOptions.IgnoreCase);
    using (r = new BinaryReader(File.OpenRead(path))) {
      r.ReadBytes(6); int ver = r.ReadInt32(); if (ver > 5) r.ReadInt32();
      int tc = r.ReadInt32();
      for (int i = 0; i < tc; i++) { r.ReadInt32(); S(); uint sz = r.ReadUInt32(); r.BaseStream.Seek(sz, SeekOrigin.Current); }
      int mc = r.ReadInt32();
      for (int i = 0; i < mc; i++) {
        S(); S(); r.ReadByte(); r.ReadByte(); r.ReadInt32();
        int pc = r.ReadInt32(); for (int k = 0; k < pc; k++) { S(); r.ReadBytes(40); }
        int t = r.ReadInt32(); for (int k = 0; k < t; k++) { S(); r.ReadInt32(); S(); }
      }
      Node(new float[] { 1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1 });
    }
  }
  static float[] Mul(float[] a, float[] b) {
    var c = new float[16];
    for (int i = 0; i < 4; i++) for (int j = 0; j < 4; j++) { float s = 0; for (int k = 0; k < 4; k++) s += a[i*4+k] * b[k*4+j]; c[i*4+j] = s; }
    return c;
  }
  void Node(float[] parent) {
    int cls = r.ReadInt32(); string name = S(); int cc = r.ReadInt32(); r.ReadByte();
    float[] W = parent;
    if (cls == 1) {
      var e = new float[16]; for (int k = 0; k < 16; k++) e[k] = r.ReadSingle();
      W = Mul(e, parent);
      if (name.StartsWith("AC_")) Points[name] = new double[] { W[12], W[13], W[14] };
    } else {
      r.ReadBytes(3);
      if (cls == 3) { int bc = r.ReadInt32(); for (int b = 0; b < bc; b++) { S(); r.ReadBytes(64); } }
      uint vc = r.ReadUInt32(); int stride = cls == 2 ? 44 : 76;
      var P = new float[vc * 3];
      for (uint v = 0; v < vc; v++) {
        float x = r.ReadSingle(), y = r.ReadSingle(), z = r.ReadSingle(); r.ReadBytes(stride - 12);
        P[v*3]   = x*W[0] + y*W[4] + z*W[8]  + W[12];
        P[v*3+1] = x*W[1] + y*W[5] + z*W[9]  + W[13];
        P[v*3+2] = x*W[2] + y*W[6] + z*W[10] + W[14];
      }
      uint ic = r.ReadUInt32(); var I = new ushort[ic]; for (uint k = 0; k < ic; k++) I[k] = r.ReadUInt16();
      r.ReadUInt32();
      if (cls == 2) r.ReadBytes(4 + 8 + 16 + 1); else r.ReadBytes(4 + 8);
      if (name.StartsWith("AC_")) {
        double sx = 0, sy = 0, sz = 0; for (uint v = 0; v < vc; v++) { sx += P[v*3]; sy += P[v*3+1]; sz += P[v*3+2]; }
        Points[name] = new double[] { sx / vc, sy / vc, sz / vc };
      } else if (keep != null && keep.IsMatch(name)) {
        for (uint k = 0; k + 2 < ic; k += 3) {
          var t = new float[9];
          for (int q = 0; q < 3; q++) { int o = I[k + q] * 3; t[q*3] = P[o]; t[q*3+1] = P[o+1]; t[q*3+2] = P[o+2]; }
          Tris.Add(t);
        }
      }
    }
    for (int c = 0; c < cc; c++) Node(W);
  }
}

public static class AiMaker {
  public static string Make(List<float[]> tris, double[] start, double[] goal, double[] gate, double cell, string outPath, string preview) {
    var log = new StringBuilder();
    double minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
    foreach (var t in tris) for (int q = 0; q < 3; q++) { minx = Math.Min(minx, t[q*3]); maxx = Math.Max(maxx, t[q*3]); minz = Math.Min(minz, t[q*3+2]); maxz = Math.Max(maxz, t[q*3+2]); }
    minx -= 5; minz -= 5; maxx += 5; maxz += 5;
    int W = (int)Math.Ceiling((maxx - minx) / cell), H = (int)Math.Ceiling((maxz - minz) / cell);
    var Y = new float[W * H]; for (int i = 0; i < Y.Length; i++) Y[i] = float.NaN;
    // rastrera vägen (cellens mittpunkt inuti triangeln)
    foreach (var t in tris) {
      double ax = t[0], az = t[2], bx = t[3], bz = t[5], cx = t[6], cz = t[8];
      double d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz); if (Math.Abs(d) < 1e-9) continue;
      int x0 = (int)Math.Floor((Math.Min(ax, Math.Min(bx, cx)) - minx) / cell), x1 = (int)Math.Floor((Math.Max(ax, Math.Max(bx, cx)) - minx) / cell);
      int z0 = (int)Math.Floor((Math.Min(az, Math.Min(bz, cz)) - minz) / cell), z1 = (int)Math.Floor((Math.Max(az, Math.Max(bz, cz)) - minz) / cell);
      for (int gz = z0; gz <= z1; gz++) for (int gx = x0; gx <= x1; gx++) {
        double px = minx + (gx + 0.5) * cell, pz = minz + (gz + 0.5) * cell;
        double l1 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / d; if (l1 < -1e-6) continue;
        double l2 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / d; if (l2 < -1e-6) continue;
        double l3 = 1 - l1 - l2; if (l3 < -1e-6) continue;
        float y = (float)(l1 * t[1] + l2 * t[4] + l3 * t[7]);
        int i = gz * W + gx; if (float.IsNaN(Y[i]) || y > Y[i]) Y[i] = y;
      }
    }
    // avstånd till vägkanten (chamfer 3-4, i celler)
    var D = new float[W * H];
    for (int i = 0; i < D.Length; i++) D[i] = float.IsNaN(Y[i]) ? 0 : 1e9f;
    for (int z = 1; z < H - 1; z++) for (int x = 1; x < W - 1; x++) { int i = z * W + x; if (D[i] == 0) continue;
      D[i] = Math.Min(D[i], Math.Min(Math.Min(D[i-1] + 1, D[i-W] + 1), Math.Min(D[i-W-1] + 1.4142f, D[i-W+1] + 1.4142f))); }
    for (int z = H - 2; z > 0; z--) for (int x = W - 2; x > 0; x--) { int i = z * W + x; if (D[i] == 0) continue;
      D[i] = Math.Min(D[i], Math.Min(Math.Min(D[i+1] + 1, D[i+W] + 1), Math.Min(D[i+W+1] + 1.4142f, D[i+W-1] + 1.4142f))); }

    Func<double[], int> nearestRoad = p => {
      int bx = (int)((p[0] - minx) / cell), bz = (int)((p[2] - minz) / cell), best = -1; double bd = 1e18;
      for (int rr = 0; rr < 80 && best < 0; rr++)
        for (int z = bz - rr; z <= bz + rr; z++) for (int x = bx - rr; x <= bx + rr; x++) {
          if (x < 0 || z < 0 || x >= W || z >= H) continue; int i = z * W + x; if (float.IsNaN(Y[i])) continue;
          double dx = minx + (x + .5) * cell - p[0], dz = minz + (z + .5) * cell - p[2], dd = dx*dx + dz*dz + (Y[i]-p[1])*(Y[i]-p[1]);
          if (dd < bd) { bd = dd; best = i; }
        }
      return best;
    };
    int s = nearestRoad(start), g = nearestRoad(goal);
    if (s < 0 || g < 0) throw new Exception("start eller mål ligger inte nära vägen");

    // Dijkstra, kostnad = steglängd × (1 + K / (avstånd till kant)²)
    var cost = new float[W * H]; for (int i = 0; i < cost.Length; i++) cost[i] = float.MaxValue;
    var prev = new int[W * H];
    var heap = new SortedSet<Tuple<float, int>>();
    cost[s] = 0; heap.Add(Tuple.Create(0f, s)); prev[s] = -1;
    int[] dxs = { 1, -1, 0, 0, 1, 1, -1, -1 }, dzs = { 0, 0, 1, -1, 1, -1, 1, -1 };
    while (heap.Count > 0) {
      var top = heap.Min; heap.Remove(top); int i = top.Item2;
      if (top.Item1 > cost[i]) continue;
      if (i == g) break;
      int x = i % W, z = i / W;
      for (int k = 0; k < 8; k++) {
        int nx = x + dxs[k], nz = z + dzs[k]; if (nx < 0 || nz < 0 || nx >= W || nz >= H) continue;
        int j = nz * W + nx; if (float.IsNaN(Y[j]) || Math.Abs(Y[j] - Y[i]) > 0.4) continue;
        double dm = D[j] * cell;
        float c = (float)(cost[i] + (k < 4 ? 1 : 1.4142) * cell * (1 + 30.0 / ((dm + 0.3) * (dm + 0.3))));
        if (c < cost[j]) { if (cost[j] != float.MaxValue) heap.Remove(Tuple.Create(cost[j], j)); cost[j] = c; prev[j] = i; heap.Add(Tuple.Create(c, j)); }
      }
    }
    if (cost[g] == float.MaxValue) throw new Exception("ingen sammanhängande väg mellan start och mål");
    var path = new List<double[]>();
    for (int i = g; i >= 0; i = prev[i]) path.Add(new double[] { minx + (i % W + .5) * cell, Y[i], minz + (i / W + .5) * cell });
    path.Reverse();
    // utjämning (±5 m) i flera varv, ändpunkterna ligger kvar
    int win = Math.Max(2, (int)(5 / cell));
    for (int pass = 0; pass < 3; pass++) {
      var sm = new List<double[]>();
      for (int i = 0; i < path.Count; i++) {
        int a = Math.Max(0, i - win), b = Math.Min(path.Count - 1, i + win), n = b - a + 1; double sx = 0, sy = 0, sz = 0;
        for (int k = a; k <= b; k++) { sx += path[k][0]; sy += path[k][1]; sz += path[k][2]; }
        sm.Add(new double[] { sx / n, sy / n, sz / n });
      }
      sm[0] = path[0]; sm[sm.Count - 1] = path[path.Count - 1]; path = sm;
    }
    // jämnt avstånd, 1,5 m
    var outPts = new List<double[]>(); var dist = new List<double>();
    outPts.Add(path[0]); dist.Add(0);
    double acc = 0, step = 1.5, along = 0;
    for (int i = 1; i < path.Count; i++) {
      double[] a = path[i - 1], b = path[i];
      double seg = Math.Sqrt((b[0]-a[0])*(b[0]-a[0]) + (b[1]-a[1])*(b[1]-a[1]) + (b[2]-a[2])*(b[2]-a[2]));
      while (acc + seg >= step) {
        double f = (step - acc) / seg;
        a = new double[] { a[0] + (b[0]-a[0]) * f, a[1] + (b[1]-a[1]) * f, a[2] + (b[2]-a[2]) * f };
        seg -= step - acc; acc = 0; along += step;
        outPts.Add(a); dist.Add(along);
      }
      acc += seg;
    }
    // höjd från vägytan (mjukt), vägbredd åt vänster/höger
    Func<double, double, int> cellAt = (x, z) => { int gx = (int)((x - minx) / cell), gz = (int)((z - minz) / cell); return gx < 0 || gz < 0 || gx >= W || gz >= H ? -1 : gz * W + gx; };
    int N = outPts.Count; var sideL = new double[N]; var sideR = new double[N];
    for (int i = 0; i < N; i++) {
      int c = cellAt(outPts[i][0], outPts[i][2]); if (c >= 0 && !float.IsNaN(Y[c])) outPts[i][1] = Y[c];
      int a = Math.Max(0, i - 2), b = Math.Min(N - 1, i + 2);
      double tx = outPts[b][0] - outPts[a][0], tz = outPts[b][2] - outPts[a][2], tl = Math.Sqrt(tx*tx + tz*tz) + 1e-9; tx /= tl; tz /= tl;
      for (int side = 0; side < 2; side++) {
        double nx = side == 0 ? -tz : tz, nz = side == 0 ? tx : -tx, w = 0;
        while (w < 30) { int cc = cellAt(outPts[i][0] + nx * w, outPts[i][2] + nz * w); if (cc < 0 || float.IsNaN(Y[cc])) break; w += cell * 0.5; }
        if (side == 0) sideL[i] = w; else sideR[i] = w;
      }
    }
    using (var bw = new BinaryWriter(File.Create(outPath))) {
      bw.Write(7); bw.Write(N); bw.Write(0); bw.Write(0);
      for (int i = 0; i < N; i++) { bw.Write((float)outPts[i][0]); bw.Write((float)outPts[i][1]); bw.Write((float)outPts[i][2]); bw.Write((float)dist[i]); bw.Write(i); }
      bw.Write(N);
      for (int i = 0; i < N; i++) for (int k = 0; k < 18; k++) bw.Write(k == 5 ? (float)sideL[i] : k == 6 ? (float)sideR[i] : 0f);
    }
    // kontroll: passerar linjen startlinjen?
    double gateD = 1e9; foreach (var p in outPts) gateD = Math.Min(gateD, Math.Sqrt((p[0]-gate[0])*(p[0]-gate[0]) + (p[2]-gate[2])*(p[2]-gate[2])));
    double minW = 1e9; for (int i = 0; i < N; i++) minW = Math.Min(minW, sideL[i] + sideR[i]);
    log.AppendFormat("rutnät {0}x{1}, {2} vägtrianglar, {3} punkter, längd {4:F0} m, höjd {5:F1} -> {6:F1} m, närmast startlinjen {7:F1} m, smalast {8:F1} m",
      W, H, tris.Count, N, dist[N - 1], outPts[0][1], outPts[N - 1][1], gateD, minW);

    if (!string.IsNullOrEmpty(preview)) {
      int sc = Math.Max(1, (int)Math.Ceiling(Math.Max(W, H) / 1400.0));
      using (var bmp = new Bitmap(W / sc, H / sc)) {
        for (int z = 0; z < H / sc; z++) for (int x = 0; x < W / sc; x++) {
          int i = (z * sc) * W + x * sc;
          bmp.SetPixel(x, H / sc - 1 - z, float.IsNaN(Y[i]) ? Color.FromArgb(25, 28, 32) : Color.FromArgb(110, 115, 120));
        }
        using (var gr = Graphics.FromImage(bmp)) {
          Func<double[], PointF> P = p => new PointF((float)((p[0] - minx) / cell / sc), (float)(H / sc - 1 - (p[2] - minz) / cell / sc));
          for (int i = 1; i < N; i++) gr.DrawLine(Pens.OrangeRed, P(outPts[i - 1]), P(outPts[i]));
          foreach (var q in new[] { Tuple.Create(start, Brushes.Lime), Tuple.Create(gate, Brushes.Cyan), Tuple.Create(goal, Brushes.Yellow) }) { var pp = P(q.Item1); gr.FillEllipse(q.Item2, pp.X - 5, pp.Y - 5, 10, 10); }
        }
        bmp.Save(preview);
      }
    }
    return log.ToString();
  }
}
'@

$geo = New-Object Kn5Geo
if ($Road.Count -eq 0) { $Road = (Get-Content (Join-Path $Track 'models.ini') | Where-Object { $_ -match '^FILE=' } | ForEach-Object { $_.Substring(5) }) }
foreach ($f in $Road) { $geo.Load((Join-Path $Track $f), $RoadPattern) }
$mk = New-Object Kn5Geo; $mk.Load((Join-Path $Track $Markers), $null)
$P = $mk.Points
foreach ($k in 'AC_START_0', 'AC_AB_START_L', 'AC_AB_START_R', 'AC_AB_FINISH_L', 'AC_AB_FINISH_R') { if (-not $P.ContainsKey($k)) { throw "$k saknas i $Markers" } }
function Mid([double[]]$a, [double[]]$b) { return , [double[]]@((($a[0] + $b[0]) / 2), (($a[1] + $b[1]) / 2), (($a[2] + $b[2]) / 2)) }
$gate = Mid $P['AC_AB_START_L'] $P['AC_AB_START_R']
$fin = Mid $P['AC_AB_FINISH_L'] $P['AC_AB_FINISH_R']
New-Item -ItemType Directory -Force (Join-Path $Track 'ai') | Out-Null
$out = Join-Path $Track 'ai\fast_lane.ai'
[AiMaker]::Make($geo.Tris, $P['AC_START_0'], $fin, $gate, $Cell, $out, $Preview)
Write-Host "Skrev $out"
