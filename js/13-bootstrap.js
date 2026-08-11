/* ---------------------------- Bootstrap ---------------------------- */

function init() {
  initLocalPlayer();
  // ИИ №30 (мультиплеер): в PvP-режиме противник — живой человек через
  // Firebase (см. 18-pvp-multiplayer.js), а не enemy_ai бот — не зовём
  // initEnemyStub(). В режиме "ai" (дефолт, старое поведение) всё как
  // раньше, ветка ниже не меняет ничего для существующих партий против бота.
  if (MultiplayerMode.mode !== "pvp") {
    initEnemyStub();
  }
  seedResourceNodes();
  buildBuildBar();
  setupNetworking();
  if (MultiplayerMode.mode === "pvp" && typeof initPvpMultiplayer === "function") {
    initPvpMultiplayer();
  }
  loadAiConfigStatus();
  logMsg("Операция начата. Удачи, командир.");
  requestAnimationFrame(loop);
}

// ИИ №8: раньше init() вызывался сразу при загрузке скрипта. Теперь запуск
// откладывается до подтверждения игроком выбора сложности/фракции на
// оверлее #enemySelectScreen (см. game.html и js/10-hud.js,
// setupEnemySelectScreen()). Это вариант "б" из п.4 задачи в
// PROMPT_FOR_NEXT_AI.md — выбран как более простой и надёжный, чем
// патчить уже идущую партию поверх initEnemyStub(): SelectedEnemyProfile
// (js/01-config-state.js) должен быть известен ДО initEnemyStub(), т.к.
// от него зависит стартовый цвет/сложность вражеского ИИ с первого тика,
// а не только его последующее поведение.
//
// setupEnemySelectScreen() сама вызывает startGameAfterSelection() (= init())
// по клику "Начать бой", либо сразу, если оверлея почему-то нет в разметке
// (см. фолбэк внутри неё в js/10-hud.js) — так что init() всегда
// вызывается ровно один раз, независимо от того, есть экран выбора или нет.
function startGameAfterSelection() {
  init();
}

// ИИ №30 (мультиплеер): добавлен новый экран выбора режима (#pvpModeScreen,
// см. js/18-pvp-multiplayer.js), который теперь показывается ПЕРВЫМ и сам
// решает, когда звать setupEnemySelectScreen()/startGameAfterSelection()
// (для режима "ai" — как раньше; для "pvp" — в обход, сразу
// startGameAfterSelection()). Если разметка #pvpModeScreen присутствует,
// автозапуск здесь ПРОПУСКАЕТСЯ — иначе старый экран сложности показался бы
// одновременно с новым экраном режима поверх него. window.__pvpModeScreenActive
// выставляется в 18-pvp-multiplayer.js синхронно при загрузке (до этой
// строки, т.к. 18 подключён раньше 13 по порядку <script>, см. game.html).
if (!window.__pvpModeScreenActive) {
  if (typeof setupEnemySelectScreen === "function") {
    setupEnemySelectScreen(startGameAfterSelection);
  } else {
    // Фолбэк на случай, если js/10-hud.js почему-то не подключён/не содержит
    // setupEnemySelectScreen — старое поведение (мгновенный старт), чтобы
    // страница не оставалась "мёртвой" молча.
    startGameAfterSelection();
  }
}
