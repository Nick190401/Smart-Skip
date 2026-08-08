/**
 * Generates the five 1280x800 Chrome Web Store screenshots as standalone HTML,
 * ready to be rasterised by a headless browser.
 */
const fs = require('fs');
const path = require('path');

const OUT = 'c:/Entwicklung/Smart-Skip/assets/store';
fs.mkdirSync(OUT, { recursive: true });

const LOGO = `<svg viewBox="0 0 512 512" class="mark">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#5b9bff"/><stop offset="100%" stop-color="#b09dff"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="108" fill="#12122a"/>
  <path d="M134 155 L134 357 L228 256 Z" fill="url(#g)"/>
  <path d="M242 155 L242 357 L336 256 Z" fill="url(#g)"/>
  <rect x="350" y="155" width="28" height="202" rx="9" fill="url(#g)"/>
</svg>`;

const CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{overflow:hidden}
body{
  background:
    radial-gradient(ellipse 70% 55% at 78% -12%, rgba(122,110,255,.20) 0%, transparent 62%),
    radial-gradient(ellipse 60% 50% at 8% 108%, rgba(79,142,247,.16) 0%, transparent 60%),
    #0a0a16;
  color:#f0f0fa;
  font:15px/1.55 'Segoe UI',-apple-system,BlinkMacSystemFont,Inter,sans-serif;
  -webkit-font-smoothing:antialiased;
  display:flex;flex-direction:column;
  padding:34px 48px 30px;
}
body::after{
  content:'';position:absolute;inset:0;pointer-events:none;
  background-image:linear-gradient(rgba(255,255,255,.018) 1px,transparent 1px),
                   linear-gradient(90deg,rgba(255,255,255,.018) 1px,transparent 1px);
  background-size:56px 56px;
  mask-image:radial-gradient(ellipse 90% 80% at 50% 40%,#000 20%,transparent 80%);
}

/* ── brand bar ─────────────────────────────────────────── */
.brand{display:flex;align-items:center;gap:13px;position:relative;z-index:2}
.mark{width:40px;height:40px;border-radius:11px;flex:0 0 auto;
      box-shadow:0 0 0 1px rgba(255,255,255,.10),0 4px 16px rgba(0,0,0,.5)}
.brand-name{font-size:19px;font-weight:750;letter-spacing:-.35px}
.brand-ver{font-size:11.5px;font-weight:650;letter-spacing:.3px;color:#8f8fb8;
  border:1px solid rgba(255,255,255,.12);border-radius:99px;padding:3px 10px;background:rgba(255,255,255,.045)}
.brand-spacer{flex:1}
.brand-tag{font-size:13px;color:#7d7da4;letter-spacing:.1px}

/* ── layout ────────────────────────────────────────────── */
.stage{flex:1;display:grid;grid-template-columns:1fr 450px;gap:36px;align-items:center;
       position:relative;z-index:2}
.stage.wide{grid-template-columns:1fr 420px}
.copy h2{font-size:36px;line-height:1.14;font-weight:760;letter-spacing:-1.05px;
         background:linear-gradient(103deg,#ffffff 30%,#b6c8ff 100%);
         -webkit-background-clip:text;background-clip:text;color:transparent}
.copy h2 em{font-style:normal;
  background:linear-gradient(103deg,#7fb0ff 0%,#c0aaff 100%);
  -webkit-background-clip:text;background-clip:text;color:transparent}
.copy p{margin-top:16px;font-size:16px;line-height:1.6;color:#a2a2c6;max-width:450px}
.points{margin-top:26px;display:flex;flex-direction:column;gap:11px}
.point{display:flex;align-items:flex-start;gap:11px;font-size:14.5px;color:#c9c9e4}
.point .tick{flex:0 0 auto;width:19px;height:19px;border-radius:50%;margin-top:1px;
  background:rgba(52,211,153,.14);border:1px solid rgba(52,211,153,.36);
  color:#34d399;font-size:11px;font-weight:800;display:flex;align-items:center;justify-content:center}
.point b{color:#f0f0fa;font-weight:650}

/* ── player mockup ─────────────────────────────────────── */
.player{position:relative;border-radius:16px;overflow:hidden;aspect-ratio:16/9;
  background:linear-gradient(150deg,#1d2340 0%,#141428 45%,#0e0e1e 100%);
  box-shadow:0 30px 70px -18px rgba(0,0,0,.85),0 0 0 1px rgba(255,255,255,.075)}
.player::before{content:'';position:absolute;inset:0;
  background:radial-gradient(ellipse 60% 70% at 30% 30%,rgba(120,150,255,.16),transparent 65%)}
.scene{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  font-size:76px;font-weight:800;letter-spacing:10px;color:rgba(255,255,255,.055)}
.ptop{position:absolute;top:18px;left:20px;right:20px;display:flex;align-items:flex-start;gap:12px}
.ptitle{font-size:15px;font-weight:700;letter-spacing:-.2px;color:rgba(255,255,255,.92)}
.psub{font-size:11.5px;color:rgba(255,255,255,.44);margin-top:2px}

.skipbtn{position:absolute;right:22px;bottom:78px;
  display:inline-flex;align-items:center;gap:8px;
  padding:11px 19px;border-radius:8px;
  background:rgba(255,255,255,.94);color:#101020;
  font-size:14px;font-weight:750;letter-spacing:-.1px;
  box-shadow:0 10px 26px rgba(0,0,0,.5)}
.skipbtn.ghost{background:rgba(255,255,255,.13);color:rgba(255,255,255,.82);
  border:1px solid rgba(255,255,255,.22);box-shadow:none}

.pbar{position:absolute;left:20px;right:20px;bottom:26px}
.shot-left{display:flex;flex-direction:column;gap:14px}
.note{display:flex;align-items:center;gap:0;
  background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.075);
  border-radius:13px;padding:13px 4px}
.note-cell{flex:1;padding:0 18px;border-right:1px solid rgba(255,255,255,.07)}
.note-cell:last-child{border-right:0}
.note-k{font-size:9.5px;font-weight:750;letter-spacing:.8px;text-transform:uppercase;color:#5f5f85}
.note-v{font-size:14px;font-weight:650;margin-top:3px;color:#dcdcf0;font-variant-numeric:tabular-nums}
.note-v.ok{color:#34d399}.note-v.ai{color:#b09dff}.note-v.warn{color:#fbbf24}
.ptrack{height:5px;border-radius:4px;background:rgba(255,255,255,.15);position:relative}
.pfill{position:absolute;left:0;top:0;bottom:0;z-index:1;border-radius:4px;
  background:rgba(255,255,255,.42)}
.pseg{position:absolute;top:-2px;bottom:-2px;z-index:2;border-radius:4px;
  box-shadow:0 0 0 1px rgba(10,10,22,.55)}
.pseg.intro{background:rgba(79,142,247,.75)}
.pseg.recap{background:rgba(251,191,36,.75)}
.pseg.credits{background:rgba(176,157,255,.7)}
.ptimes{display:flex;justify-content:space-between;margin-top:8px;
  font-size:11px;color:rgba(255,255,255,.42);font-variant-numeric:tabular-nums}
.plabels{position:relative;height:15px;margin-bottom:7px}
.plabel{position:absolute;top:0;transform:translateX(-50%);white-space:nowrap;
  font-size:9.5px;font-weight:750;letter-spacing:.55px;text-transform:uppercase}
.plabel.intro{color:#7fb0ff}.plabel.recap{color:#fbbf24}.plabel.credits{color:#c0aaff}

/* HUD chip, mirrors the real in-player overlay */
.hud{position:absolute;display:inline-flex;align-items:center;gap:7px;white-space:nowrap;
  padding:7px 13px;border-radius:20px;
  background:rgba(13,13,13,.86);border:1px solid rgba(255,255,255,.16);
  font-size:12px;font-weight:650;color:#fff;
  box-shadow:0 8px 24px rgba(0,0,0,.55)}
.hud .badge{padding:2px 8px;border-radius:10px;font-size:10px;font-weight:800;
  letter-spacing:.5px;text-transform:uppercase}
.badge.skip{background:#16a34a}
.badge.ai{background:#7c3aed}
.badge.undo{background:rgba(255,255,255,.2);border:1px solid rgba(255,255,255,.36)}

/* ── generic cards ─────────────────────────────────────── */
.panel{background:rgba(255,255,255,.038);border:1px solid rgba(255,255,255,.08);
  border-radius:16px;padding:20px 22px}
.panel-h{font-size:10.5px;font-weight:750;letter-spacing:.9px;text-transform:uppercase;
  color:#6f6f96;margin-bottom:14px}

.xlate{display:flex;flex-direction:column;gap:9px}
.xrow{display:flex;align-items:center;gap:12px}
.xbtn{flex:0 0 214px;padding:8px 13px;border-radius:7px;font-size:13px;font-weight:650;
  background:rgba(255,255,255,.9);color:#101020;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.xarrow{color:#5a5a80;font-size:14px}
.xtag{padding:4px 11px;border-radius:99px;font-size:11.5px;font-weight:750;letter-spacing:.3px}
.xtag.intro{background:rgba(79,142,247,.16);color:#7fb0ff;border:1px solid rgba(79,142,247,.34)}
.xtag.recap{background:rgba(251,191,36,.15);color:#fbbf24;border:1px solid rgba(251,191,36,.32)}
.xtag.next{background:rgba(52,211,153,.14);color:#34d399;border:1px solid rgba(52,211,153,.32)}
.xtag.credits{background:rgba(176,157,255,.16);color:#c0aaff;border:1px solid rgba(176,157,255,.34)}

/* toggle rows for the settings shot */
.trow{display:flex;align-items:center;justify-content:space-between;gap:16px;
  padding:11px 0;border-bottom:1px solid rgba(255,255,255,.055)}
.trow:last-child{border-bottom:0}
.tlabel{font-size:14px;font-weight:600}
.tdesc{font-size:11.5px;color:#6f6f96;margin-top:1px}
.sw{width:38px;height:22px;border-radius:99px;position:relative;flex:0 0 auto;
  background:rgba(255,255,255,.11);border:1px solid rgba(255,255,255,.1)}
.sw::after{content:'';position:absolute;top:2.5px;left:3px;width:16px;height:16px;border-radius:50%;
  background:#8e8eb4}
.sw.on{background:rgba(79,142,247,.85);border-color:rgba(79,142,247,.9);
  box-shadow:0 0 14px rgba(79,142,247,.45)}
.sw.on::after{left:auto;right:3px;background:#fff}

/* ── footer strip ──────────────────────────────────────── */
.foot{position:relative;z-index:2;margin-top:26px;padding-top:16px;
  border-top:1px solid rgba(255,255,255,.07);
  display:flex;align-items:center;gap:14px}
.foot-label{font-size:10.5px;font-weight:750;letter-spacing:.85px;text-transform:uppercase;color:#5f5f85;flex:0 0 auto}
.foot-list{font-size:12.5px;color:#8888ae;letter-spacing:.05px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.foot-list b{color:#b9b9d6;font-weight:600}
`;

const FOOT = `<div class="foot">
  <span class="foot-label">Works on</span>
  <span class="foot-list"><b>Netflix · Prime Video · Disney+ · Crunchyroll · Max · Paramount+ · Hulu · Apple TV+ · Peacock · Joyn · Sky · RTL+ · ZDF · ARD</b> and 6 more</span>
</div>`;

const page = (title, stage, wide) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>${CSS}</style><style>html,body{width:1280px;height:800px}</style></head>
<body>
  <div class="brand">
    ${LOGO}
    <div>
      <div class="brand-name">Smart Skip</div>
    </div>
    <span class="brand-ver">v2.1</span>
    <span class="brand-spacer"></span>
    <span class="brand-tag">Auto-skip for streaming · on-device AI</span>
  </div>
  <div class="stage${wide ? ' wide' : ''}">${stage}</div>
  ${FOOT}
</body></html>`;


const note = (cells) => `<div class="note">${cells.map(([k, v, cls]) =>
  `<div class="note-cell"><div class="note-k">${k}</div><div class="note-v${cls ? ' ' + cls : ''}">${v}</div></div>`
).join('')}</div>`;

const point = (t) => `<div class="point"><span class="tick">✓</span><span>${t}</span></div>`;

/* ── 1. hero ───────────────────────────────────────────── */
const s1 = page('Smart Skip — auto-skip', `
  <div class="shot-left">
  <div class="player">
    <div class="scene">NORTHWIND</div>
    <div class="ptop">
      <div>
        <div class="ptitle">Northwind</div>
        <div class="psub">Season 2 · Episode 4 — “Low Tide”</div>
      </div>
    </div>
    <div class="hud" style="top:18px;right:20px">
      <span>⏭</span><span>Northwind</span><span class="badge skip">Intro 92% · AI</span>
    </div>
    <div class="skipbtn">Skip Intro</div>
    <div class="pbar">
      <div class="ptrack">
        <div class="pseg intro" style="left:6%;width:11%"></div>
        <div class="pfill" style="width:17%"></div>
      </div>
      <div class="ptimes"><span>02:24</span><span>-19:36</span></div>
    </div>
  </div>
  ${note([
    ['Segment', 'Intro'],
    ['Found at', '02:24'],
    ['Classified by', 'Gemini Nano', 'ai'],
    ['Skip verified', 'button gone', 'ok'],
  ])}
  </div>
  <div class="copy">
    <h2>Intros, recaps and credits,<br><em>gone before you notice.</em></h2>
    <p>Smart Skip watches the player, recognises the skip button and presses it for you, normally within a second of it appearing.</p>
    <div class="points">
      ${point('Handles <b>intro, recap, credits, ads</b> and next-episode prompts')}
      ${point('Reveals buttons that only show up <b>on mouse-over</b>')}
      ${point('Verifies every skip actually worked — and <b>unlearns</b> what didn’t')}
    </div>
  </div>`);

/* ── 2. back-to-back segments ──────────────────────────── */
const s2 = page('Smart Skip — back-to-back segments', `
  <div class="shot-left">
  <div class="player">
    <div class="scene">NORTHWIND</div>
    <div class="ptop">
      <div>
        <div class="ptitle">Northwind</div>
        <div class="psub">Recap ends 00:48 · Intro starts 00:48</div>
      </div>
    </div>
    <div class="hud" style="top:18px;right:20px;opacity:.5">
      <span>⏭</span><span>Recap</span><span class="badge skip">Skipped</span>
    </div>
    <div class="hud" style="top:62px;right:20px">
      <span>⏭</span><span>Intro</span><span class="badge skip">Skipped · +1.2 s</span>
    </div>
    <div class="skipbtn">Skip Intro</div>
    <div class="pbar">
      <div class="plabels">
        <span class="plabel recap" style="left:11%">Recap</span>
        <span class="plabel intro" style="left:30%">Intro</span>
      </div>
      <div class="ptrack">
        <div class="pseg recap" style="left:3%;width:16%"></div>
        <div class="pseg intro" style="left:19%;width:22%"></div>
        <div class="pfill" style="width:41%"></div>
      </div>
      <div class="ptimes"><span>00:00</span><span>22:00</span></div>
    </div>
  </div>
  ${note([
    ['First segment', 'Recap · skipped', 'ok'],
    ['Second segment', 'Intro · skipped', 'ok'],
    ['Gap between', '≈ 1.2 s', 'ai'],
    ['Rescan interval', '0.5 s'],
  ])}
  </div>
  <div class="copy">
    <h2>Recap running straight into the intro? <em>Both skipped.</em></h2>
    <p>Two segments back to back is where auto-skippers usually give up — they press one button and stop looking. Smart Skip scans hardest right after a jump, because that is exactly when the next button appears.</p>
    <div class="points">
      ${point('Catches the second segment in about <b>one second</b>')}
      ${point('Follows players that <b>relabel the same button</b> instead of replacing it')}
      ${point('Records each segment separately, so timings stay accurate')}
    </div>
  </div>`);

/* ── 3. on-device AI ───────────────────────────────────── */
const s3 = page('Smart Skip — on-device AI', `
  <div>
    <div class="panel" style="margin-bottom:18px">
      <div class="panel-h">Buttons found on the page → what the AI made of them</div>
      <div class="xlate">
        <div class="xrow"><span class="xbtn">Intro überspringen</span><span class="xarrow">→</span><span class="xtag intro">intro</span></div>
        <div class="xrow"><span class="xbtn">Skip Recap</span><span class="xarrow">→</span><span class="xtag recap">recap</span></div>
        <div class="xrow"><span class="xbtn">Saltar introducción</span><span class="xarrow">→</span><span class="xtag intro">intro</span></div>
        <div class="xrow"><span class="xbtn">オープニングをスキップ</span><span class="xarrow">→</span><span class="xtag intro">intro</span></div>
        <div class="xrow"><span class="xbtn">Regarder le générique</span><span class="xarrow">→</span><span class="xtag credits">credits</span></div>
        <div class="xrow"><span class="xbtn">Nächste Folge</span><span class="xarrow">→</span><span class="xtag next">next episode</span></div>
      </div>
    </div>
    <div class="panel" style="display:flex;align-items:center;gap:16px;padding:16px 22px">
      <span class="hud" style="position:static;box-shadow:none">
        <span>⏭</span><span>Smart Skip</span><span class="badge ai">AI ready</span>
      </span>
      <span style="font-size:13px;color:#8888ae">Gemini Nano runs inside Chrome. No button text, no page content and no video ever leaves your machine.</span>
    </div>
  </div>
  <div class="copy">
    <h2>On-device AI reads the player. <em>Nothing leaves your machine.</em></h2>
    <p>Gemini Nano classifies the buttons it finds — whatever the language, whatever the layout. No model on your device? A rule engine covering twelve languages takes over automatically.</p>
    <div class="points">
      ${point('Works on layouts nobody wrote a rule for')}
      ${point('<b>No account, no sign-in</b>, no personal data collected')}
      ${point('Sharing anonymous timings is <b>opt-in</b> and revocable')}
    </div>
  </div>`, true);

/* ── 4. no button ──────────────────────────────────────── */
const s4 = page('Smart Skip — works without a skip button', `
  <div class="shot-left">
  <div class="player">
    <div class="scene">NORTHWIND</div>
    <div class="ptop">
      <div>
        <div class="ptitle">Northwind</div>
        <div class="psub">Season 2 · Episode 7 — no skip button in this episode</div>
      </div>
    </div>
    <div class="hud" style="top:18px;right:20px">
      <span>⏭</span><span>Intro</span><span class="badge skip">Skipped 62 → 152 s</span>
    </div>
    <div class="hud" style="top:62px;right:20px">
      <span>⏭</span><span>Not an intro?</span><span class="badge undo">Undo</span>
    </div>
    <div class="skipbtn ghost">no button offered</div>
    <div class="pbar">
      <div class="plabels">
        <span class="plabel intro" style="left:16%">Learned intro</span>
        <span class="plabel credits" style="left:88%">Credits</span>
      </div>
      <div class="ptrack">
        <div class="pseg intro" style="left:6%;width:20%"></div>
        <div class="pseg credits" style="left:82%;width:15%"></div>
        <div class="pfill" style="width:26%"></div>
      </div>
      <div class="ptimes"><span>02:32</span><span>-19:28</span></div>
    </div>
  </div>
  ${note([
    ['Learned from', 'chapter + subtitles'],
    ['Intro', '62 → 152 s'],
    ['Confirmed live', 'yes', 'ok'],
    ['Undo offered for', '5 s', 'warn'],
  ])}
  </div>
  <div class="copy">
    <h2>No skip button? <em>It still knows where the intro is.</em></h2>
    <p>Smart Skip learns where each segment starts and ends — from chapter markers, subtitle cues, the player’s own timing data and the skips you make yourself — then jumps at the right moment on its own.</p>
    <div class="points">
      ${point('A remembered window only fires when the page <b>confirms it live</b>')}
      ${point('Otherwise you get a <b>one-tap skip prompt</b> instead of a surprise jump')}
      ${point('<b>Undo</b> is always there, and it teaches the window to stop firing')}
    </div>
  </div>`);

/* ── 5. control ────────────────────────────────────────── */
const s5 = page('Smart Skip — per-series control', `
  <div>
    <div class="panel">
      <div class="panel-h">Northwind — Season 2, Episode 4</div>
      <div class="trow">
        <div><div class="tlabel">Skip intro</div><div class="tdesc">Opening / theme</div></div>
        <div class="sw on"></div>
      </div>
      <div class="trow">
        <div><div class="tlabel">Skip recap</div><div class="tdesc">“Previously on…”</div></div>
        <div class="sw on"></div>
      </div>
      <div class="trow">
        <div><div class="tlabel">Skip credits</div><div class="tdesc">Outro — off, this show has post-credit scenes</div></div>
        <div class="sw"></div>
      </div>
      <div class="trow">
        <div><div class="tlabel">Skip ads</div><div class="tdesc">Skip-ad buttons</div></div>
        <div class="sw on"></div>
      </div>
      <div class="trow">
        <div><div class="tlabel">Auto next episode</div><div class="tdesc">Start the next one without asking</div></div>
        <div class="sw"></div>
      </div>
    </div>
    <div class="panel" style="margin-top:16px;display:flex;align-items:center;gap:12px;padding:15px 22px">
      <span class="xtag intro">Pause 15 min</span>
      <span class="xtag intro">Pause 1 h</span>
      <span class="xtag recap">Off for this site</span>
      <span style="font-size:12.5px;color:#7d7da4;margin-left:auto">Alt + S — scan now</span>
    </div>
  </div>
  <div class="copy">
    <h2>Your rules — <em>per series, per episode.</em></h2>
    <p>Skip the intro but sit through the credits. Turn everything off for one site. Pause for an hour when someone else takes the remote. Every switch is per show, and any single episode can override it.</p>
    <div class="points">
      ${point('Live overlay shows <b>what was skipped and why</b>')}
      ${point('Daily counter on the toolbar icon')}
      ${point('Delete everything the extension learned, per site or entirely')}
    </div>
  </div>`, true);

const { tileSmall, tileLarge } = require('./tiles.js');

const shots = [
  ['screenshot-1-auto-skip.html', s1],
  ['screenshot-2-back-to-back.html', s2],
  ['screenshot-3-on-device-ai.html', s3],
  ['screenshot-4-no-button.html', s4],
  ['screenshot-5-control.html', s5],
  ['tile-small-440x280.html', tileSmall(LOGO)],
  ['tile-marquee-1400x560.html', tileLarge(LOGO)],
];
for (const [name, html] of shots) {
  fs.writeFileSync(path.join(OUT, name), html, 'utf8');
  console.log('wrote', name);
}
