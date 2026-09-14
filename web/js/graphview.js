/* GraphView — the knowledge graph drawn on a canvas.

   A tiny force layout: the two hubs (you, her) sit apart, every other node
   is pulled to its neighbours and pushed from everyone else. Tap a node to
   light up its edges; the list under the canvas is the same graph as text
   with a remove button per fact. */
(function (global) {
  'use strict';

  var HUB_R = 22, R = 14;

  function t(k, fb) { return (global.I18n && I18n.tc) ? I18n.tc(k, fb) : fb; }

  var GraphView = {
    _sim: null,

    /* host: element to fill; charId; names {user, me}; onChange() after a removal */
    render: function (host, charId, names, onChange) {
      if (!host || !global.Graph) return;
      GraphView.stop();
      host.innerHTML = '';
      var g = Graph.list(charId);
      var edges = g.edges.slice();
      if (!edges.length) {
        var e = document.createElement('p'); e.className = 'hint graph-empty';
        e.textContent = t('graph.empty', 'Nothing learned yet. Facts she picks up from your talks will appear here as a web.');
        host.appendChild(e);
        return;
      }
      var wrap = document.createElement('div'); wrap.className = 'graph-wrap';
      var canvas = document.createElement('canvas'); canvas.className = 'graph-canvas';
      wrap.appendChild(canvas);
      host.appendChild(wrap);

      var ids = {};
      edges.forEach(function (ed) { ids[ed.s] = 1; ids[ed.o] = 1; });
      var nodes = Object.keys(ids).map(function (id, i, arr) {
        var hub = id === 'user' || id === 'me';
        var a = (i / arr.length) * Math.PI * 2;
        return { id: id, hub: hub, label: id === 'user' ? (names.user || 'you') : id === 'me' ? (names.me || 'her') : ((g.nodes[id] && g.nodes[id].label) || id),
                 x: 0.5 + Math.cos(a) * 0.3, y: 0.5 + Math.sin(a) * 0.3, vx: 0, vy: 0 };
      });
      var byId = {}; nodes.forEach(function (n) { byId[n.id] = n; });
      var selected = null;

      var W = 0, H = 0, dpr = Math.max(1, global.devicePixelRatio || 1);
      var size = function () {
        W = wrap.clientWidth || 320; H = Math.max(220, Math.min(360, Math.round(W * 0.7)));
        canvas.width = W * dpr; canvas.height = H * dpr;
        canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
      };
      size();
      var u = byId.user, m = byId.me;
      if (u) { u.x = 0.3; u.y = 0.5; }
      if (m) { m.x = 0.7; m.y = 0.5; }

      var step = function () {
        var i, j, a, b, dx, dy, d, f;
        for (i = 0; i < nodes.length; i++) for (j = i + 1; j < nodes.length; j++) {
          a = nodes[i]; b = nodes[j];
          dx = b.x - a.x; dy = b.y - a.y; d = Math.sqrt(dx * dx + dy * dy) + 0.01;
          f = 0.0035 / (d * d);
          if (f > 0.05) f = 0.05;
          a.vx -= dx / d * f; a.vy -= dy / d * f; b.vx += dx / d * f; b.vy += dy / d * f;
        }
        edges.forEach(function (ed) {
          a = byId[ed.s]; b = byId[ed.o];
          if (!a || !b) return;
          dx = b.x - a.x; dy = b.y - a.y; d = Math.sqrt(dx * dx + dy * dy) + 0.01;
          f = (d - 0.28) * 0.02;
          a.vx += dx / d * f; a.vy += dy / d * f; b.vx -= dx / d * f; b.vy -= dy / d * f;
        });
        nodes.forEach(function (n) {
          if (n.hub) { n.vx *= 0.2; n.vy *= 0.2; }
          n.vx += (0.5 - n.x) * 0.002; n.vy += (0.5 - n.y) * 0.003;
          n.vx *= 0.85; n.vy *= 0.85;
          n.x = Math.min(0.95, Math.max(0.05, n.x + n.vx));
          n.y = Math.min(0.92, Math.max(0.08, n.y + n.vy));
        });
      };

      var draw = function () {
        var ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        var acc = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#5aa9ff';
        ctx.lineWidth = 1.2;
        edges.forEach(function (ed) {
          var a = byId[ed.s], b = byId[ed.o];
          if (!a || !b) return;
          var lit = selected && (ed.s === selected || ed.o === selected);
          ctx.strokeStyle = lit ? acc : (ed.ended ? 'rgba(169,180,204,.18)' : 'rgba(90,169,255,.35)');
          ctx.setLineDash(ed.ended ? [4, 4] : []);
          ctx.beginPath(); ctx.moveTo(a.x * W, a.y * H); ctx.lineTo(b.x * W, b.y * H); ctx.stroke();
          if (lit) {
            ctx.setLineDash([]);
            ctx.fillStyle = '#eef3ff'; ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center';
            ctx.fillText(ed.r, (a.x + b.x) / 2 * W, (a.y + b.y) / 2 * H - 4);
          }
        });
        ctx.setLineDash([]);
        nodes.forEach(function (n) {
          var r = n.hub ? HUB_R : R;
          var lit = selected === n.id;
          ctx.beginPath(); ctx.arc(n.x * W, n.y * H, r, 0, Math.PI * 2);
          ctx.fillStyle = n.hub ? (n.id === 'user' ? 'rgba(61,123,255,.9)' : 'rgba(255,154,213,.85)') : (lit ? acc : 'rgba(22,30,48,.95)');
          ctx.fill();
          ctx.strokeStyle = lit ? '#fff' : 'rgba(90,169,255,.6)'; ctx.lineWidth = lit ? 2 : 1; ctx.stroke();
          ctx.fillStyle = '#fff'; ctx.font = (n.hub ? 'bold 12px' : '11px') + ' system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          var lab = n.label.length > 16 ? n.label.slice(0, 15) + '…' : n.label;
          if (n.hub) ctx.fillText(lab, n.x * W, n.y * H);
          else { ctx.fillStyle = '#eef3ff'; ctx.fillText(lab, n.x * W, n.y * H + r + 10); }
        });
      };

      var frames = 0;
      var loop = function () {
        if (!host.isConnected) { GraphView.stop(); return; }
        if (frames < 240) { step(); frames++; }
        draw();
        GraphView._sim = requestAnimationFrame(loop);
      };
      loop();

      canvas.onclick = function (ev) {
        var r = canvas.getBoundingClientRect();
        var x = (ev.clientX - r.left) / W, y = (ev.clientY - r.top) / H;
        var best = null, bd = 1;
        nodes.forEach(function (n) { var d = Math.hypot((n.x - x) * W, (n.y - y) * H); if (d < 28 && d < bd) { bd = d; best = n; } });
        selected = best ? (selected === best.id ? null : best.id) : null;
        frames = Math.min(frames, 200);
        list.querySelectorAll('.graph-fact').forEach(function (li) {
          var ed = edges[li.getAttribute('data-i') | 0];
          li.classList.toggle('lit', !!selected && (ed.s === selected || ed.o === selected));
        });
      };

      /* the same facts as text */
      var list = document.createElement('div'); list.className = 'graph-list';
      edges.slice().reverse().forEach(function (ed) {
        var i = edges.indexOf(ed);
        var li = document.createElement('div'); li.className = 'graph-fact' + (ed.ended ? ' ended' : '');
        li.setAttribute('data-i', i);
        var txt = document.createElement('span'); txt.textContent = Graph.line(ed, g, names);
        var when = document.createElement('small'); when.textContent = new Date(ed.last).toLocaleDateString();
        var x = document.createElement('button'); x.type = 'button'; x.className = 'gift-x'; x.textContent = '✕';
        x.onclick = function () { Graph.removeEdge(charId, i); onChange && onChange(); };
        li.appendChild(txt); li.appendChild(when); li.appendChild(x);
        list.appendChild(li);
      });
      host.appendChild(list);
    },

    stop: function () { if (GraphView._sim) cancelAnimationFrame(GraphView._sim); GraphView._sim = null; }
  };

  global.GraphView = GraphView;
})(typeof window !== 'undefined' ? window : globalThis);
