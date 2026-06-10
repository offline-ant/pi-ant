"use strict";

var data = null;
var cwd = "";
var LS_PREFIX = "ctx-explorer:lvl:";

function lvlKey(fullPath) {
  return LS_PREFIX + fullPath;
}

function getLvl(fullPath) {
  var v = localStorage.getItem(lvlKey(fullPath));
  return v !== null ? parseInt(v, 10) : 0;
}

function setLvl(fullPath, lvl) {
  localStorage.setItem(lvlKey(fullPath), String(lvl));
}

function cycleLvl(fullPath) {
  var cur = getLvl(fullPath);
  var next = cur >= 9 ? 0 : cur + 1;
  setLvl(fullPath, next);
  applyFilter();
}

function lvlColor(lvl) {
  if (lvl === 0) return "var(--dim)";
  if (lvl <= 3) return "#58a6ff";
  if (lvl <= 6) return "#d29922";
  return "#f85149";
}

function lvlBg(lvl) {
  if (lvl === 0) return "transparent";
  if (lvl <= 3) return "rgba(88,166,255,0.12)";
  if (lvl <= 6) return "rgba(210,153,34,0.12)";
  return "rgba(248,81,73,0.12)";
}

function rowBg(pct) {
  var a = pct / 100 * 0.35;
  return "rgba(63,185,80," + a.toFixed(2) + ")";
}

function pctColor(pct) {
  if (pct >= 75) return "var(--read)";
  if (pct >= 50) return "#7ee787";
  if (pct >= 25) return "#56d364";
  return "#a5d6ff";
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function escAttr(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function lvlCell(fullPath) {
  var lvl = getLvl(fullPath);
  var display = lvl === 0 ? "\u00B7" : String(lvl);
  return '<td class="lvl-col" data-path="' + escAttr(fullPath) + '"'
    + ' style="color:' + lvlColor(lvl) + ";background:" + lvlBg(lvl) + '"'
    + ' title="Click to cycle importance (0-9)">' + display + "</td>";
}

function loadData() {
  document.getElementById("loading").style.display = "block";
  fetch("/api/data")
    .then(function (r) { return r.json(); })
    .then(function (d) {
      data = d;
      cwd = d.cwd;
      document.getElementById("loading").style.display = "none";
      document.getElementById("cwd").textContent = d.cwd;
      applyFilter();
    })
    .catch(function (e) {
      document.getElementById("loading").style.display = "none";
      document.getElementById("read-tbody").innerHTML =
        '<tr><td class="error" colspan="4">Error: ' + e.message + "</td></tr>";
    });
}

function applyFilter() {
  if (!data) return;

  var filterEl = document.getElementById("filter");
  var filter = filterEl ? filterEl.value.toLowerCase() : "";

  var files = data.files;
  if (filter) {
    files = files.filter(function (f) { return f.path.toLowerCase().indexOf(filter) !== -1; });
  }

  var readFiles = files.filter(function (f) { return f.readPct > 0; });
  var unreadFiles = files.filter(function (f) { return f.readPct === 0; });

  // Sort by level descending, then readPct descending
  function fullPath(f) { return (cwd + "/" + f.path).replace(/\/\//g, "/"); }
  function cmpLvl(a, b) { return getLvl(fullPath(b)) - getLvl(fullPath(a)) || b.readPct - a.readPct; }
  readFiles.sort(cmpLvl);
  unreadFiles.sort(function (a, b) { return getLvl(fullPath(b)) - getLvl(fullPath(a)); });

  // Stats
  var total = files.length;
  var readN = readFiles.length;
  var covPct = total > 0 ? Math.round(readN / total * 100) : 0;
  document.getElementById("stats").innerHTML =
    '<div class="stat"><div class="val">' + total + '</div><div class="lbl">files</div></div>' +
    '<div class="stat"><div class="val">' + readN + '</div><div class="lbl">read</div></div>' +
    '<div class="stat"><div class="val">' + covPct + '%</div><div class="lbl">coverage</div></div>';

  document.getElementById("read-count").textContent = readN + " files";
  document.getElementById("unread-count").textContent = unreadFiles.length + " files";

  // Read table
  document.getElementById("read-tbody").innerHTML = readFiles.map(function (f) {
    var pct = f.readPct;
    var fp = fullPath(f);
    return '<tr style="background:' + rowBg(pct) + '">'
      + '<td class="path-col" title="' + escAttr(f.path) + '">' + f.path + "</td>"
      + '<td class="size-col">' + formatSize(f.size) + "</td>"
      + lvlCell(fp)
      + '<td class="pct-col" style="color:' + pctColor(pct) + '">' + pct + "%</td>"
      + "</tr>";
  }).join("");

  // Unread table
  document.getElementById("unread-tbody").innerHTML = unreadFiles.map(function (f) {
    var fp = fullPath(f);
    return '<tr class="unread-row">'
      + '<td class="path-col" title="' + escAttr(f.path) + '">' + f.path + "</td>"
      + '<td class="size-col">' + formatSize(f.size) + "</td>"
      + lvlCell(fp)
      + "</tr>";
  }).join("");
}

// Event delegation for level clicks
document.body.addEventListener("click", function (e) {
  var td = e.target.closest(".lvl-col");
  if (td && td.dataset.path) {
    cycleLvl(td.dataset.path);
  }
});

// Filter input
document.getElementById("filter").addEventListener("input", function () {
  applyFilter();
});

// Refresh button
document.getElementById("refresh-btn").addEventListener("click", function () {
  loadData();
});

// Init
loadData();
setInterval(loadData, 10000);
