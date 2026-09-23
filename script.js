const $ = selector => document.querySelector(selector);
const globe = $('#playlistUniverse');
const audio = new Audio();
audio.preload = 'metadata';

const fma = 'https://files.freemusicarchive.org/storage-freemusicarchive-org/music/';
function album(id, directory, entries) {
  return entries.map(([title, file]) => ({ title, artist: 'Komiku', album: id.replaceAll('_', ' '), cover: `assets/cover-${id}.jpg`, src: `${fma}${directory}/${file}` }));
}
const tracks = [
  ...album('Poupis_incredible_adventures_', 'Music_for_Video/Komiku/Poupis_incredible_adventures_', [
    ['Opening !', 'Komiku_-_01_-_Opening_.mp3'], ["Poupi's Theme", 'Komiku_-_02_-_Poupis_Theme.mp3'],
    ['Time for the walk of the day', 'Komiku_-_03_-_Time_for_the_walk_of_the_day.mp3'],
    ['The weekly fair', 'Komiku_-_04_-_The_weekly_fair.mp3'], ['Surfing', 'Komiku_-_05_-_Surfing.mp3']
  ]),
  ...album('Captain_Glouglous_Incredible_Week_Soundtrack', 'Music_for_Video/Komiku/Captain_Glouglous_Incredible_Week_Soundtrack', [
    ['Soundtrack', 'Komiku_-_01_-_Soundtrack.mp3'], ['Home', 'Komiku_-_02_-_Home.mp3'],
    ['Mushrooms', 'Komiku_-_03_-_Mushrooms.mp3'], ['Skate', 'Komiku_-_04_-_Skate.mp3'], ['Beach', 'Komiku_-_05_-_Beach.mp3']
  ]),
  ...album('Its_time_for_adventure_', 'no_curator/Komiku/Its_time_for_adventure_', [
    ["Fouler l'horizon", 'Komiku_-_01_-_Fouler_lhorizon.mp3'], ['Le Grand Village', 'Komiku_-_02_-_Le_Grand_Village.mp3'],
    ['Champ de tournesol', 'Komiku_-_03_-_Champ_de_tournesol.mp3'], ['Barque sur le lac', 'Komiku_-_04_-_Barque_sur_le_lac.mp3'],
    ['La Citadelle', 'Komiku_-_05_-_La_Citadelle.mp3']
  ]),
  ...album('Its_time_for_adventure__vol_2', 'no_curator/Komiku/Its_time_for_adventure__vol_2', [
    ['Balance', 'Komiku_-_01_-_Balance.mp3'], ['Chill Out Theme', 'Komiku_-_02_-_Chill_Out_Theme.mp3'],
    ['Battle Theme', 'Komiku_-_03_-_Battle_Theme.mp3'], ['Time', 'Komiku_-_04_-_Time.mp3'],
    ['Down the river', 'Komiku_-_05_-_Down_the_river.mp3']
  ]),
  ...album('Its_time_for_adventure__vol_3', 'Music_for_Video/Komiku/Its_time_for_adventure__vol_3', [
    ['Childhood scene', 'Komiku_-_01_-_Childhood_scene.mp3'],
    ['The first person crossing the bridge since a century', 'Komiku_-_02_-_The_first_person_crossing_the_bridge_since_a_century.mp3'],
    ["Big person, tiny cities (world map's theme)", 'Komiku_-_03_-_Big_person_tiny_cities_world_maps_theme.mp3'],
    ['Save me from my prison, heroic principal character', 'Komiku_-_04_-_Save_me_from_my_prison_heroic_principal_character.mp3'],
    ['How to evade a place with no wall', 'Komiku_-_05_-_How_to_evade_a_place_with_no_wall.mp3']
  ]),
  ...album('Its_time_for_adventure__vol_4', 'Music_for_Video/Komiku/Its_time_for_adventure__vol_4', [
    ['Opening', 'Komiku_-_01_-_Opening.mp3'], ['Every myths are true stories', 'Komiku_-_02_-_Every_myths_are_true_stories.mp3'],
    ['Where you hear the prayer (McGuffin theme)', 'Komiku_-_03_-_Where_you_hear_the_prayer_McGuffin_theme.mp3'],
    ["I got 99 broadswords but this one isn't one", 'Komiku_-_04_-_I_got_99_broadswords_but_this_one_isnt_one_stores_theme.mp3'],
    ["Sorry, I'm maybe available in an other minor quest !", 'Komiku_-_05_-_Sorry_Im_maybe_available_in_an_other_minor_quest__Bonus_Characters_theme.mp3']
  ])
];
tracks.forEach((track, index) => {
  track.sourceUrl = track.src;
  track.src = `assets/track-${String(index + 1).padStart(2, '0')}.mp3`;
});
const cards = tracks.map((track, index) => {
  const card = document.createElement('button');
  card.className = 'mix-card';
  card.type = 'button';
  card.dataset.track = String(index);
  card.setAttribute('aria-label', `播放 ${track.title} — ${track.artist}`);
  const art = document.createElement('span');
  art.className = 'orb-art';
  const image = document.createElement('img');
  image.src = track.cover;
  image.alt = '';
  image.loading = index > 14 ? 'lazy' : 'eager';
  art.append(image);
  const title = document.createElement('span');
  title.className = 'orb-title';
  title.textContent = track.title;
  card.append(art, title);
  globe.insertBefore(card, $('#doneBtn'));
  return card;
});

let trackIndex = 0;
let selectedCard = cards[0];
let rotation = { x: 0, y: 0 };
let slots = [];
let gesture = null;
let holdTimer = null;
let momentumFrame = null;
let suppressClickUntil = 0;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const formatTime = seconds => Number.isFinite(seconds) ? `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` : '00:00';

function updateProgress() {
  const progress = $('#progress');
  const percentage = audio.duration ? audio.currentTime / audio.duration * 100 : 0;
  progress.value = percentage;
  progress.style.setProperty('--played', `${percentage}%`);
  $('#currentTime').textContent = formatTime(audio.currentTime);
  $('#duration').textContent = formatTime(audio.duration);
}

function updatePlaybackButton() {
  const button = $('#mainPlay');
  button.textContent = audio.paused ? '▶' : 'Ⅱ';
  button.setAttribute('aria-label', audio.paused ? '播放' : '暂停');
}

function loadTrack(index, play = false) {
  trackIndex = (index + tracks.length) % tracks.length;
  const track = tracks[trackIndex];
  audio.src = track.src;
  audio.load();
  $('#trackTitle').textContent = track.title;
  $('#trackArtist').textContent = track.artist;
  $('#mainCover').src = track.cover;
  $('#mainCover').alt = `${track.album} 专辑封面`;
  $('#heartBtn').setAttribute('aria-pressed', 'false');
  $('#heartBtn').textContent = '♡';
  cards.forEach(card => card.classList.toggle('active', card === selectedCard));
  updateProgress();
  if (play) audio.play().catch(() => updatePlaybackButton());
  updatePlaybackButton();
}

audio.addEventListener('timeupdate', updateProgress);
audio.addEventListener('loadedmetadata', updateProgress);
audio.addEventListener('play', updatePlaybackButton);
audio.addEventListener('pause', updatePlaybackButton);
audio.addEventListener('ended', () => chooseNext(1, true));
audio.addEventListener('error', () => { $('#trackArtist').textContent = '音频暂时无法读取'; updatePlaybackButton(); });
$('#mainPlay').addEventListener('click', () => audio.paused ? audio.play().catch(() => updatePlaybackButton()) : audio.pause());
$('#prevBtn').addEventListener('click', () => chooseNext(-1, !audio.paused));
$('#nextBtn').addEventListener('click', () => chooseNext(1, !audio.paused));
$('#progress').addEventListener('input', event => {
  if (audio.duration) audio.currentTime = Number(event.target.value) / 100 * audio.duration;
  updateProgress();
});
$('#heartBtn').addEventListener('click', event => {
  const pressed = event.currentTarget.getAttribute('aria-pressed') !== 'true';
  event.currentTarget.setAttribute('aria-pressed', String(pressed));
  event.currentTarget.textContent = pressed ? '♥' : '♡';
});

function geometry() {
  return { base: cards[0].offsetWidth, height: cards[0].offsetHeight,
    radiusX: globe.clientWidth * (globe.clientWidth > 570 ? .45 : .47), radiusY: globe.clientHeight * .46,
    cx: globe.clientWidth / 2, cy: globe.clientHeight / 2 };
}

function rebuildSlots() {
  const { base, height } = geometry();
  slots = [];
  [5, 6, 8, 6, 5].forEach((count, row) => {
    for (let column = 0; column < count; column++) {
      slots.push({ x: (column - (count - 1) / 2) * base * (globe.clientWidth > 570 ? 1.48 : 1.32),
        y: (row - 2) * height * 1.16 });
    }
  });
}

function project(slot) {
  const { radiusX, radiusY, cx, cy } = geometry();
  const longitude = slot.x / radiusX + rotation.y;
  const latitude = -slot.y / radiusY + rotation.x;
  const depth = Math.cos(latitude) * Math.cos(longitude);
  return { x: cx + radiusX * Math.cos(latitude) * Math.sin(longitude),
    y: cy - radiusY * Math.sin(latitude), depth };
}

function layout(skip = null) {
  rebuildSlots();
  let frontCard = null;
  let frontDepth = -Infinity;
  cards.forEach(card => {
    const point = project(slots[Number(card.dataset.slot)]);
    const scale = clamp(.52 + point.depth * .5, .39, 1.02);
    if (card !== skip) {
      card.style.left = `${point.x}px`;
      card.style.top = `${point.y}px`;
    }
    card.style.setProperty('--scale', scale.toFixed(3));
    card.style.zIndex = String(Math.round(point.depth * 100));
    card.style.opacity = String(clamp((point.depth - .02) * 1.6, 0, 1));
    card.style.filter = `brightness(${clamp(.58 + point.depth * .46, .58, 1.04)})`;
    card.style.pointerEvents = card === skip ? '' : point.depth < .08 ? 'none' : '';
    if (point.depth > frontDepth) { frontDepth = point.depth; frontCard = card; }
  });
  cards.forEach(card => card.classList.toggle('is-focus', card === frontCard));
}

function cancelMomentum() {
  if (momentumFrame) cancelAnimationFrame(momentumFrame);
  momentumFrame = null;
  globe.classList.remove('is-coasting');
}

function focusCard(card, play = true) {
  cancelMomentum();
  const slot = slots[Number(card.dataset.slot)];
  const { radiusX, radiusY } = geometry();
  rotation.y = clamp(-slot.x / radiusX, -1.25, 1.25);
  rotation.x = clamp(slot.y / radiusY, -1.15, 1.15);
  selectedCard = card;
  layout();
  loadTrack(Number(card.dataset.track), play);
}

function chooseNext(direction, play) {
  const nextIndex = (trackIndex + direction + tracks.length) % tracks.length;
  const candidate = cards.find(card => Number(card.dataset.track) === nextIndex && card !== selectedCard);
  if (candidate) focusCard(candidate, play);
  else loadTrack(nextIndex, play);
}

function rotateBy(dx, dy) {
  const { radiusX, radiusY } = geometry();
  rotation.y = clamp(rotation.y + dx / radiusX, -1.25, 1.25);
  rotation.x = clamp(rotation.x - dy / radiusY, -1.15, 1.15);
  layout();
}

function setEditMode(editing) {
  globe.classList.toggle('is-editing', editing);
  $('#globeHint').textContent = editing ? '拖动玻璃唱片换位 · 点击完成' : '拖动旋转 · 轻点播放 · 长按换位';
}

function dragCardToPointer(card, clientX, clientY) {
  const rect = globe.getBoundingClientRect();
  const x = clientX - rect.left - gesture.grabX;
  const y = clientY - rect.top - gesture.grabY;
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;
  let closest = -1;
  let distance = Infinity;
  slots.forEach((slot, index) => {
    const point = project(slot);
    if (point.depth < .16) return;
    const d = Math.hypot(x - point.x, y - point.y);
    if (d < distance) { distance = d; closest = index; }
  });
  if (closest < 0 || closest === Number(card.dataset.slot) || distance > geometry().base * .78) return;
  const previous = card.dataset.slot;
  const displaced = cards.find(item => item !== card && Number(item.dataset.slot) === closest);
  if (displaced) displaced.dataset.slot = previous;
  card.dataset.slot = String(closest);
  layout(card);
  navigator.vibrate?.(8);
}

function startReorder(card) {
  if (!gesture || gesture.card !== card || gesture.mode !== 'pending' && gesture.mode !== 'reorder') return;
  cancelMomentum();
  setEditMode(true);
  gesture.mode = 'reorder';
  const rect = card.getBoundingClientRect();
  gesture.grabX = gesture.lastX - (rect.left + rect.width / 2);
  gesture.grabY = gesture.lastY - (rect.top + rect.height / 2);
  card.classList.add('dragging');
  dragCardToPointer(card, gesture.lastX, gesture.lastY);
  navigator.vibrate?.(20);
}

function beginGesture(event, card = null) {
  if (event.button !== 0 || gesture) return;
  cancelMomentum();
  gesture = { pointerId: event.pointerId, card,
    mode: card ? 'pending' : 'pan', startX: event.clientX, startY: event.clientY,
    lastX: event.clientX, lastY: event.clientY, velocityX: 0, velocityY: 0,
    grabX: 0, grabY: 0 };
  (card || globe).setPointerCapture(event.pointerId);
  if (card) {
    if (globe.classList.contains('is-editing')) startReorder(card);
    else holdTimer = setTimeout(() => startReorder(card), 430);
  } else globe.classList.add('is-panning');
}

function moveGesture(event) {
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  const dx = event.clientX - gesture.lastX;
  const dy = event.clientY - gesture.lastY;
  gesture.lastX = event.clientX;
  gesture.lastY = event.clientY;
  if (gesture.mode === 'pending' && Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 7) {
    clearTimeout(holdTimer);
    gesture.mode = 'pan';
    globe.classList.add('is-panning');
  }
  if (gesture.mode === 'pan') {
    gesture.velocityX = dx;
    gesture.velocityY = dy;
    rotateBy(dx, dy);
  } else if (gesture.mode === 'reorder') dragCardToPointer(gesture.card, event.clientX, event.clientY);
}

function endGesture(event) {
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  clearTimeout(holdTimer);
  const target = gesture.card || globe;
  const mode = gesture.mode;
  const velocityX = gesture.velocityX;
  const velocityY = gesture.velocityY;
  if (mode === 'reorder') {
    gesture.card.classList.remove('dragging');
    suppressClickUntil = Date.now() + 420;
    layout();
  }
  if (mode === 'pan') suppressClickUntil = Date.now() + 360;
  gesture = null;
  globe.classList.remove('is-panning');
  try { target.releasePointerCapture(event.pointerId); } catch (_) {}
  if (mode !== 'pan' || reducedMotion.matches) return;
  let vx = velocityX * .66;
  let vy = velocityY * .66;
  globe.classList.add('is-coasting');
  const coast = () => {
    vx *= .87; vy *= .87;
    if (Math.abs(vx) + Math.abs(vy) < .3) { cancelMomentum(); return; }
    rotateBy(vx, vy);
    momentumFrame = requestAnimationFrame(coast);
  };
  momentumFrame = requestAnimationFrame(coast);
}

cards.forEach((card, index) => {
  card.dataset.slot = String((index * 7 + 14) % cards.length);
  card.addEventListener('contextmenu', event => event.preventDefault());
  card.addEventListener('pointerdown', event => { event.stopPropagation(); beginGesture(event, card); });
  card.addEventListener('pointermove', event => { event.stopPropagation(); moveGesture(event); });
  card.addEventListener('pointerup', event => { event.stopPropagation(); endGesture(event); });
  card.addEventListener('pointercancel', event => { event.stopPropagation(); endGesture(event); });
  card.addEventListener('click', event => {
    if (Date.now() < suppressClickUntil || globe.classList.contains('is-editing')) { event.preventDefault(); return; }
    focusCard(card, true);
  });
});
globe.addEventListener('pointerdown', event => {
  if (event.target.closest('.mix-card, .done-button')) return;
  if (globe.classList.contains('is-editing')) { setEditMode(false); return; }
  beginGesture(event);
});
globe.addEventListener('pointermove', moveGesture);
globe.addEventListener('pointerup', endGesture);
globe.addEventListener('pointercancel', endGesture);
$('#doneBtn').addEventListener('click', event => { event.stopPropagation(); setEditMode(false); });
new ResizeObserver(layout).observe(globe);
layout();
loadTrack(0);
