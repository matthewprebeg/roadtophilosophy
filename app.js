// ─── Constants & state ────────────────────────────────────────────────────────
const PHILOSOPHY = 'Philosophy';
const MAX_HOPS   = 60;

const CHAIN_COLORS = [
  '#2563eb','#e11d48','#7c3aed','#ea580c','#059669','#db2777','#0891b2','#ca8a04'
];

const CHAIN_STATUS = {
  running: { label: 'running',   cls: 'status-running' },
  done:    { label: 'reached φ', cls: 'status-done'    },
  loop:    { label: 'loop',      cls: 'status-loop'    },
  error:   { label: 'error',     cls: 'status-error'   },
};

const state = {
  chains:       [],  // [{ id, title, color, nodes[], status, errorMsg? }]
  allNodes:     {},  // title → { chains: Set, isPhilosophy, depth }
  allEdges:     [],  // [{ source, target, chainId }]
  runningCount: 0,
  nextChainId:  0,
};

// ─── Depth calculation ────────────────────────────────────────────────────────
// Assigns each node its minimum hop-distance from Philosophy.
// Drives the spoke layout — deeper nodes are pushed further out.
function computeDepths() {
  Object.values(state.allNodes).forEach(n => { n.depth = Infinity; });
  if (state.allNodes[PHILOSOPHY]) state.allNodes[PHILOSOPHY].depth = 0;
  state.chains.forEach(chain => {
    chain.nodes.forEach((title, i) => {
      const node = state.allNodes[title];
      if (!node) return;
      const depth = chain.status === 'done'
        ? chain.nodes.length - 1 - i  // exact once chain is complete
        : chain.nodes.length - i;     // estimate while still running
      node.depth = Math.min(node.depth, depth);
    });
  });
}

// ─── Sector finder ────────────────────────────────────────────────────────────
// Returns the angle of the emptiest 1/16th sector around (cx, cy),
// so new chains don't spawn on top of existing ones.
function findEmptySector(cx, cy) {
  const SECTORS = 16;
  const counts = new Array(SECTORS).fill(0);
  graphNodes.forEach(n => {
    if (n.id === PHILOSOPHY || n.x == null) return;
    const a = Math.atan2(n.y - cy, n.x - cx); // −π to π
    counts[Math.floor(((a + Math.PI) / (2 * Math.PI)) * SECTORS) % SECTORS]++;
  });
  const min = Math.min(...counts);
  const empties = counts.reduce((acc, c, i) => c === min ? [...acc, i] : acc, []);
  const chosen = empties[Math.floor(Math.random() * empties.length)];
  return (chosen / SECTORS) * 2 * Math.PI - Math.PI;
}

// ─── Wikipedia API ────────────────────────────────────────────────────────────
function extractTitle(input) {
  input = input.trim();
  try {
    const url = new URL(input.startsWith('http') ? input : 'https://' + input);
    const match = url.pathname.match(/\/wiki\/(.+)/);
    if (match) return decodeURIComponent(match[1]).replace(/_/g, ' ');
  } catch(e) {}
  return input.replace(/_/g, ' ');
}

async function fetchFirstLink(title) {
  const encoded = encodeURIComponent(title.replace(/ /g, '_'));
  const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encoded}&prop=text&format=json&origin=*&redirects=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for "${title}"`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.info || `Unknown API error for "${title}"`);

  const doc = new DOMParser().parseFromString(data.parse.text['*'], 'text/html');

  doc.querySelectorAll([
    'table', '.infobox', '.sidebar', '.navbox', '.mw-empty-elt',
    'sup', '.reference', '.reflist', '.IPA', '.nowrap',
    '.hatnote', '.dablink', '.shortdescription', 'style', 'script'
  ].join(',')).forEach(el => el.remove());

  const root = doc.querySelector('.mw-parser-output') || doc.body;

  // Only scan the lead section — content before the first <h2>
  const lead = [];
  for (const child of root.children) {
    if (child.tagName === 'H2') break;
    lead.push(child);
  }

  for (const node of lead) {
    const paragraphs = node.tagName === 'P' ? [node] : node.querySelectorAll('p');
    for (const p of paragraphs) {
      if (p.textContent.trim().length < 5) continue;
      const link = findFirstLinkOutsideParens(p, title);
      if (link) return link;
    }
  }
  return null;
}

// Walks the paragraph DOM, tracking parenthesis depth, and returns the first
// valid /wiki/ link that isn't inside parentheses.
function findFirstLinkOutsideParens(paragraph, currentTitle) {
  let depth = 0;

  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      for (const ch of node.textContent) {
        if (ch === '(') depth++;
        else if (ch === ')') depth = Math.max(0, depth - 1);
      }
      return null;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'sup') return null;
      if (tag === 'a' && node.getAttribute('href')?.startsWith('/wiki/')) {
        const href = node.getAttribute('href');
        if (depth === 0 && !/\/wiki\/(File:|Special:|Help:|Wikipedia:|Talk:|Category:|Portal:|Wiktionary:)/i.test(href)) {
          const linkTitle = decodeURIComponent(href.replace('/wiki/', '')).replace(/_/g, ' ');
          if (linkTitle && linkTitle !== currentTitle && !linkTitle.startsWith('#')) return linkTitle;
        }
        for (const ch of node.textContent) {
          if (ch === '(') depth++;
          else if (ch === ')') depth = Math.max(0, depth - 1);
        }
        return null;
      }
      for (const child of node.childNodes) {
        const result = walk(child);
        if (result) return result;
      }
    }
    return null;
  }

  return walk(paragraph);
}

// ─── Chain management ─────────────────────────────────────────────────────────
function deleteChain(chainId) {
  state.chains = state.chains.filter(c => c.id !== chainId);

  Object.keys(state.allNodes).forEach(title => {
    state.allNodes[title].chains.delete(chainId);
    if (state.allNodes[title].chains.size === 0) delete state.allNodes[title];
  });

  state.allEdges = state.allEdges.filter(e => e.chainId !== chainId);

  document.getElementById(`card-${chainId}`)?.remove();

  if (state.chains.length === 0) {
    document.getElementById('stats-bar').style.display = 'none';
    document.getElementById('chains-list').innerHTML =
      '<div class="chains-empty">Paste a Wikipedia link<br>and trace its path to Philosophy</div>';
  }

  updateStats();
  computeDepths();
  updateGraph();
}

// ─── UI toggles ───────────────────────────────────────────────────────────────
function toggleHeader() {
  document.getElementById('app-header').classList.toggle('open');
}

let mobileDrawerOpen = false;
function toggleMobileDrawer() {
  mobileDrawerOpen = !mobileDrawerOpen;
  document.getElementById('sidebar').classList.toggle('mobile-open', mobileDrawerOpen);
  document.getElementById('mobile-chevron').style.transform = mobileDrawerOpen ? 'rotate(180deg)' : '';
}

function mobileRun() {
  const mInput = document.getElementById('mobile-input');
  document.getElementById('wiki-input').value = mInput.value;
  mInput.value = '';
  startChain();
}

// ─── Audio engine ─────────────────────────────────────────────────────────────
let audioCtx = null;
let reverbNode = null;
let droneNodes = [];
let droneMaster = null;

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function getReverbNode() {
  if (!reverbNode) {
    const ctx = getAudioCtx();
    const duration = 5, decay = 3;
    const buf = ctx.createBuffer(2, ctx.sampleRate * duration, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++)
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, decay);
    }
    reverbNode = ctx.createConvolver();
    reverbNode.buffer = buf;
    const wet = ctx.createGain();
    wet.gain.value = 0.55;
    reverbNode.connect(wet);
    wet.connect(ctx.destination);
  }
  return reverbNode;
}

function playBell(freq, gainPeak, duration) {
  try {
    const ctx = getAudioCtx();
    const reverb = getReverbNode();
    const now = ctx.currentTime;
    [[freq, gainPeak, duration], [freq * 2.756, gainPeak * 0.22, duration * 0.5]].forEach(([f, g, d]) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      const dry  = ctx.createGain();
      dry.gain.value = 0.25;
      osc.connect(gain);
      gain.connect(dry);   dry.connect(ctx.destination);
      gain.connect(reverb);
      osc.type = 'sine'; osc.frequency.value = f;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(g, now + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + d);
      osc.start(now); osc.stop(now + d + 0.1);
    });
  } catch(e) {}
}

function chimeNode()       { playBell(329.63, 0.045, 2.2); }
function chimeShared()     { playBell(392.00, 0.055, 3.0); setTimeout(() => playBell(493.88, 0.04, 3.0), 80); }
function chimePhilosophy() {
  playBell(523.25, 0.07, 5.0);
  setTimeout(() => playBell(659.25, 0.055, 5.0), 180);
  setTimeout(() => playBell(783.99, 0.04,  5.0), 360);
}
function chimeLoop() {
  // Soft descending minor third — melancholic winding-down
  playBell(370.00, 0.05, 2.8);
  setTimeout(() => playBell(311.13, 0.04, 3.2), 320);
}

function startDrone() {
  try {
    const ctx = getAudioCtx();
    droneMaster = ctx.createGain();
    droneMaster.gain.setValueAtTime(0, ctx.currentTime);
    droneMaster.gain.linearRampToValueAtTime(0.032, ctx.currentTime + 6);
    const dry = ctx.createGain(); dry.gain.value = 0.12;
    droneMaster.connect(getReverbNode());
    droneMaster.connect(dry); dry.connect(ctx.destination);

    // A1, E2, A2, E3 — open fifth drone with slow individual tremolo
    [55, 82.41, 110, 164.81].forEach((freq, i) => {
      const osc     = ctx.createOscillator();
      const lfo     = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      const oscGain = ctx.createGain();
      lfo.frequency.value = 0.04 + i * 0.013;
      lfoGain.gain.value  = 0.28;
      lfo.connect(lfoGain); lfoGain.connect(oscGain.gain);
      oscGain.gain.value  = [0.5, 0.35, 0.25, 0.18][i];
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.detune.value = (Math.random() - 0.5) * 5;
      osc.connect(oscGain); oscGain.connect(droneMaster);
      lfo.start(); osc.start();
      droneNodes.push(osc, lfo);
    });
  } catch(e) {}
}

function stopDrone() {
  if (!droneMaster) return;
  try {
    droneMaster.gain.linearRampToValueAtTime(0, getAudioCtx().currentTime + 4);
    setTimeout(() => {
      droneNodes.forEach(n => { try { n.stop(); } catch(e) {} });
      droneNodes = [];
      droneMaster = null;
    }, 4500);
  } catch(e) {}
}

// ─── Performance mode ─────────────────────────────────────────────────────────
let perfMode = false;
let perfInterval = null;
let perfBgInterval = null;
const PERF_INTERVAL  = 5000;
const PERF_MAX_CHAINS = 10;

function shiftBg() {
  const color = `hsl(${Math.floor(Math.random() * 360)},${72 + Math.floor(Math.random() * 23)}%,${48 + Math.floor(Math.random() * 18)}%)`;
  document.getElementById('graph-area').style.backgroundColor = color;
  document.getElementById('sidebar').style.backgroundColor   = color;
  document.getElementById('mobile-bar').style.backgroundColor = color;
}

function togglePerfMode() {
  perfMode = !perfMode;
  document.getElementById('perf-btn').classList.toggle('active', perfMode);
  document.getElementById('perf-label').textContent = perfMode ? 'Stop' : 'Performance mode';
  document.getElementById('mobile-perf-btn').classList.toggle('active', perfMode);
  if (perfMode) {
    startDrone();
    runPerfChain();
    perfInterval   = setInterval(runPerfChain, PERF_INTERVAL);
    shiftBg();
    perfBgInterval = setInterval(shiftBg, 9000);
  } else {
    clearInterval(perfInterval);   perfInterval   = null;
    clearInterval(perfBgInterval); perfBgInterval = null;
    stopDrone();
    ['graph-area', 'sidebar', 'mobile-bar'].forEach(id => {
      document.getElementById(id).style.backgroundColor = '';
    });
  }
}

async function runPerfChain() {
  if (state.chains.length >= PERF_MAX_CHAINS) {
    const oldest = state.chains.find(c => c.status !== 'running');
    if (oldest) deleteChain(oldest.id);
  }
  try {
    const res  = await fetch('https://en.wikipedia.org/api/rest_v1/page/random/summary');
    const data = await res.json();
    document.getElementById('wiki-input').value = data.title;
    await startChain(true);
  } catch(e) {}
}

// ─── Chain runner ─────────────────────────────────────────────────────────────
async function startChain(auto = false) {
  const input = document.getElementById('wiki-input').value.trim();
  if (!input) return;
  if (!auto && state.runningCount > 0) return;

  const startTitle = extractTitle(input);
  if (!startTitle) return;

  state.runningCount++;
  document.getElementById('run-btn').disabled = true;
  document.getElementById('mobile-run-btn').disabled = true;
  document.getElementById('wiki-input').value = '';

  const chainId = state.nextChainId++;
  const chain = { id: chainId, title: startTitle, color: CHAIN_COLORS[chainId % CHAIN_COLORS.length], nodes: [], status: 'running' };
  state.chains.push(chain);

  renderSidebar();
  showGraph();

  const visited = new Set();
  let current = startTitle;

  for (let i = 0; i < MAX_HOPS; i++) {
    if (visited.has(current)) {
      chain.status = 'loop';
      if (perfMode) chimeLoop();
      break;
    }
    visited.add(current);

    if (!state.allNodes[current])
      state.allNodes[current] = { chains: new Set(), visits: 0, isPhilosophy: current === PHILOSOPHY };
    state.allNodes[current].chains.add(chainId);
    state.allNodes[current].visits++;

    if (perfMode) {
      if (current === PHILOSOPHY)                          chimePhilosophy();
      else if (state.allNodes[current].chains.size > 1)   chimeShared();
      else                                                 chimeNode();
    }

    if (chain.nodes.length > 0)
      state.allEdges.push({ source: chain.nodes[chain.nodes.length - 1], target: current, chainId });

    chain.nodes.push(current);
    updateGraph();
    updateChainCard(chain);
    updateStats();

    await new Promise(r => setTimeout(r, 250));

    if (current === PHILOSOPHY) { chain.status = 'done'; break; }

    try {
      const next = await fetchFirstLink(current);
      if (!next) { chain.status = 'error'; chain.errorMsg = `No valid link found in "${current}"`; break; }
      current = next;
    } catch(e) {
      chain.status = 'error';
      chain.errorMsg = e.message;
      break;
    }
  }

  if (chain.status === 'running') chain.status = 'loop';

  updateChainCard(chain);
  updateStats();
  state.runningCount = Math.max(0, state.runningCount - 1);
  if (state.runningCount === 0) {
    document.getElementById('run-btn').disabled = false;
    document.getElementById('mobile-run-btn').disabled = false;
  }
}

// ─── Sidebar rendering ────────────────────────────────────────────────────────
function renderSidebar() {
  document.getElementById('stats-bar').style.display = 'flex';
  const list = document.getElementById('chains-list');
  list.innerHTML = '';
  state.chains.forEach(c => {
    const el = document.createElement('div');
    el.className = 'chain-card';
    el.id = `card-${c.id}`;
    list.appendChild(el);
    renderChainCard(el, c);
  });
}

function updateChainCard(chain) {
  const el = document.getElementById(`card-${chain.id}`);
  if (el) renderChainCard(el, chain);
}

function renderChainCard(el, chain) {
  const nodesHtml = chain.nodes.map((n, i) => {
    const isPhi     = n === PHILOSOPHY;
    const isShared  = state.allNodes[n]?.chains.size > 1;
    const isCurrent = i === chain.nodes.length - 1 && chain.status === 'running';
    let cls = 'node-row';
    if (isPhi)          cls += ' is-philosophy';
    else if (isShared)  cls += ' is-shared';
    else if (isCurrent) cls += ' is-current';

    const tag = isPhi
      ? `<span class="node-tag tag-phi">φ</span>`
      : isShared ? `<span class="node-tag tag-shared">∩</span>` : '';

    return `<div class="${cls}">
      <span class="node-idx${isCurrent ? ' pulse' : ''}">${i + 1}</span>
      <span class="node-arrow">→</span>
      <span class="node-label" title="${n}">${n}</span>
      ${tag}
    </div>`;
  }).join('');

  el.innerHTML = `
    <div class="chain-header">
      <div class="chain-swatch" style="background:${chain.color}"></div>
      <span class="chain-title">${chain.title}</span>
      <span class="chain-count">${chain.nodes.length}</span>
      <span class="chain-status ${CHAIN_STATUS[chain.status].cls}">${CHAIN_STATUS[chain.status].label}</span>
      <button class="chain-delete" onclick="deleteChain(${chain.id})" title="Remove">×</button>
    </div>
    ${chain.errorMsg ? `<div style="padding:6px 12px;font-size:0.6rem;color:#dc2626;border-top:1px solid #fee2e2">${chain.errorMsg}</div>` : ''}
    <div class="chain-nodes">${nodesHtml}</div>`;

  const nodesEl = el.querySelector('.chain-nodes');
  if (nodesEl) nodesEl.scrollTop = nodesEl.scrollHeight;
}

function updateStats() {
  const chains = state.chains.length;
  const nodes  = Object.keys(state.allNodes).length;
  const shared = Object.values(state.allNodes).filter(n => n.chains.size > 1).length;
  document.getElementById('stat-chains').textContent = chains;
  document.getElementById('stat-nodes').textContent  = nodes;
  document.getElementById('stat-shared').textContent = shared;
  const badge = document.getElementById('mobile-chain-badge');
  if (badge) badge.textContent = chains > 0 ? chains : '';
}

// ─── D3 graph ─────────────────────────────────────────────────────────────────
let simulation, svg, zoomBehavior, gMain, gLinks, gNodes;
let graphNodes = [], graphLinks = [];

function showGraph() {
  document.getElementById('graph-empty').style.display = 'none';
  document.getElementById('graph-svg').style.display = 'block';
  document.getElementById('legend').style.display = 'flex';
  if (!svg) initGraph();
}

function initGraph() {
  svg = d3.select('#graph-svg');
  zoomBehavior = d3.zoom().scaleExtent([0.08, 5]).on('zoom', e => gMain.attr('transform', e.transform));
  svg.call(zoomBehavior);

  gMain  = svg.append('g');
  gLinks = gMain.append('g').attr('class', 'links-layer');
  gNodes = gMain.append('g').attr('class', 'nodes-layer');

  simulation = d3.forceSimulation()
    .alphaDecay(0.012)    // slow cool-down → graph drifts gently into place
    .velocityDecay(0.22)  // low friction → playful bounce when dragging
    .force('link',      d3.forceLink().id(d => d.id).distance(80).strength(0.35))
    .force('charge',    d3.forceManyBody().strength(d => d.id === PHILOSOPHY ? -700 : -260).distanceMax(500))
    .force('collision', d3.forceCollide(14))
    .force('x',         d3.forceX().strength(0))
    .force('y',         d3.forceY().strength(0));
}

function updateGraph() {
  if (!svg) return;

  const container = document.getElementById('graph-area');
  const cx = container.clientWidth  / 2;
  const cy = container.clientHeight / 2;

  computeDepths();

  // Rebuild node map, preserving existing positions
  const nodeMap = {};
  state.chains.forEach(c => {
    let chainAngle = null;
    c.nodes.forEach((n, idx) => {
      if (nodeMap[n]) return;
      const existing = graphNodes.find(x => x.id === n);
      if (existing) { nodeMap[n] = existing; return; }

      const parent = idx > 0
        ? (nodeMap[c.nodes[idx - 1]] || graphNodes.find(x => x.id === c.nodes[idx - 1]))
        : null;

      if (parent) {
        nodeMap[n] = { id: n, x: parent.x + (Math.random() - 0.5) * 50, y: parent.y + (Math.random() - 0.5) * 50 };
      } else {
        if (chainAngle === null) chainAngle = findEmptySector(cx, cy);
        const dist = 80 + Math.random() * 40;
        nodeMap[n] = { id: n, x: cx + Math.cos(chainAngle) * dist, y: cy + Math.sin(chainAngle) * dist };
      }
    });
  });
  graphNodes = Object.values(nodeMap);

  // Rebuild link list (deduplicated)
  const linkSet = new Set();
  graphLinks = [];
  state.allEdges.forEach(e => {
    const key = `${e.source}→${e.target}`;
    if (!linkSet.has(key)) { linkSet.add(key); graphLinks.push({ source: e.source, target: e.target, chainId: e.chainId }); }
  });

  const tooltip = document.getElementById('tooltip');

  gLinks.selectAll('.link')
    .data(graphLinks, d => `${d.source?.id || d.source}→${d.target?.id || d.target}`)
    .join(
      enter => enter.append('line').attr('class', 'link').attr('stroke', '#000').attr('stroke-width', 1)
        .attr('opacity', 0).call(e => e.transition().duration(400).attr('opacity', 1)),
      update => update,
      exit => exit.transition().duration(200).attr('opacity', 0).remove()
    );

  gNodes.selectAll('.node')
    .data(graphNodes, d => d.id)
    .join(
      enter => {
        const g = enter.append('g').attr('class', 'node').style('cursor', 'pointer');

        // Spawn: scale up from zero, then clear inline style so CSS hover works
        g.append('path').attr('class', 'node-shape')
          .style('opacity', 0).style('transform', 'scale(0)')
          .call(e => e.transition().duration(300).ease(d3.easeCubicOut)
            .style('opacity', 1).style('transform', 'scale(1)')
            .on('end', function() { d3.select(this).style('transform', null).style('opacity', null); }));

        g.append('text')
          .attr('class', 'node-label-text').attr('text-anchor', 'middle')
          .attr('font-family', 'Arial, sans-serif').attr('pointer-events', 'none')
          .attr('opacity', 0)
          .call(e => e.transition().delay(250).duration(300).attr('opacity', 1));

        g.call(d3.drag()
          .on('start', (event, d) => { if (!event.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
          .on('drag',  (event, d) => { d.fx = event.x; d.fy = event.y; })
          .on('end',   (event, d) => {
            if (!event.active) simulation.alphaTarget(0.08).restart();
            d.fx = null; d.fy = null;
            setTimeout(() => simulation.alphaTarget(0), 600);
          }));

        g.on('mouseout', () => tooltip.classList.remove('visible'));
        g.on('mousemove', (event, d) => {
          const nd = state.allNodes[d.id];
          const chainIds = nd ? [...nd.chains] : [];
          const names = chainIds.map(id => state.chains.find(c => c.id === id)?.title).filter(Boolean).join(', ');
          tooltip.innerHTML = `<strong>${d.id}</strong><br>
            <span style="color:#94a3b8;font-size:0.62rem">chains: ${chainIds.length}</span>
            ${names ? `<br><span style="color:#94a3b8;font-size:0.6rem">${names}</span>` : ''}`;
          tooltip.classList.add('visible');
          tooltip.style.left = (event.clientX + 14) + 'px';
          tooltip.style.top  = (event.clientY - 12) + 'px';
        });

        return g;
      },
      update => update,
      exit => exit.transition().duration(200).style('opacity', 0).remove()
    );

  // Update shape + label on every node (enter + update)
  gNodes.selectAll('.node').each(function(d) {
    const g          = d3.select(this);
    const isPhi      = d.id === PHILOSOPHY;
    const chainCount = state.allNodes[d.id]?.chains.size ?? 1;
    const shape      = g.select('.node-shape');
    let labelOffset;

    if (isPhi) {
      shape.attr('d', hexagonPath(8)).classed('star-shape', true).classed('node-square', false).classed('node-circle', false);
      labelOffset = 20;
    } else if (chainCount > 1) {
      shape.attr('d', 'M-6,-6 h12 v12 h-12 Z').classed('star-shape', false).classed('node-square', true).classed('node-circle', false);
      labelOffset = 17;
    } else {
      shape.attr('d', circlePath(6)).classed('star-shape', false).classed('node-square', false).classed('node-circle', true);
      labelOffset = 16;
    }

    g.select('.node-label-text')
      .attr('dy', labelOffset).attr('font-size', '11px').attr('font-weight', '500').attr('fill', '#1a1a18')
      .text(isPhi ? 'Philosophy' : (d.id.length > 16 ? d.id.slice(0, 14) + '…' : d.id));
  });

  simulation.nodes(graphNodes);
  simulation.force('link').links(graphLinks);

  // Spoke forces: each chain gets an evenly-spaced angle; depth controls distance
  const totalChains = Math.max(state.chains.length, 1);
  function spokeTarget(d, axis) {
    if (d.id === PHILOSOPHY) return axis === 'x' ? cx : cy;
    const nd    = state.allNodes[d.id];
    const chain = nd ? [...nd.chains][0] ?? 0 : 0;
    const angle = (chain / totalChains) * 2 * Math.PI - Math.PI / 2;
    const dist  = Math.min((nd?.depth ?? 3) * 85, 460);
    return (axis === 'x' ? cx + Math.cos(angle) * dist : cy + Math.sin(angle) * dist);
  }
  simulation.force('x').x(d => spokeTarget(d, 'x')).strength(0.1);
  simulation.force('y').y(d => spokeTarget(d, 'y')).strength(0.1);
  simulation.force('collision').radius(14);

  // Gently warm — existing nodes keep momentum
  simulation.alpha(Math.max(simulation.alpha(), 0.18)).restart();

  simulation.on('tick', () => {
    gLinks.selectAll('.link')
      .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    gNodes.selectAll('.node').attr('transform', d => `translate(${d.x},${d.y})`);
  });
}

// ─── Shape helpers ────────────────────────────────────────────────────────────
function circlePath(r) {
  return `M ${r} 0 A ${r} ${r} 0 1 0 ${-r} 0 A ${r} ${r} 0 1 0 ${r} 0 Z`;
}

function hexagonPath(R) {
  return Array.from({ length: 6 }, (_, i) => {
    const a = i * Math.PI / 3;
    return `${i === 0 ? 'M' : 'L'}${(Math.cos(a) * R).toFixed(3)},${(Math.sin(a) * R).toFixed(3)}`;
  }).join(' ') + ' Z';
}

// ─── Zoom ─────────────────────────────────────────────────────────────────────
function zoomBy(factor) {
  if (svg) svg.transition().duration(250).call(zoomBehavior.scaleBy, factor);
}

function resetZoom() {
  if (!svg) return;
  const c = document.getElementById('graph-area');
  svg.transition().duration(350).call(
    zoomBehavior.transform,
    d3.zoomIdentity.translate(c.clientWidth / 2, c.clientHeight / 2).scale(0.9)
      .translate(-c.clientWidth / 2, -c.clientHeight / 2)
  );
}

// ─── Zen mode ─────────────────────────────────────────────────────────────────
function enterZenMode() {
  document.body.classList.add('zen-mode');
  if (!perfMode) togglePerfMode();
}

function exitZenMode() {
  document.body.classList.remove('zen-mode');
}

// ─── Event listeners ──────────────────────────────────────────────────────────
document.getElementById('wiki-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') startChain();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.body.classList.contains('zen-mode')) exitZenMode();
});
