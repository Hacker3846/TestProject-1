function logMsg(text, cls) {
  const log = document.getElementById("log");
  const div = document.createElement("div");
  if (cls) div.className = cls;
  const t = new Date().toLocaleTimeString();
  div.textContent = `[${t}] ${text}`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  while (log.children.length > 60) log.removeChild(log.firstChild);
}

/* ---------------------------- Инициализация игрока/карты ---------------------------- */

function initLocalPlayer() {
  State.players[localPlayerId] = {
    id: localPlayerId,
    credits: GameConfig.startCredits,
    power: 0,
    powerUse: 0,
    color: "#c9a227",
    side: "GDI-ish",
  };
  document.getElementById("playerLabel").textContent = localPlayerId;

  // Стартовый штаб
  const hqId = uid("b");
  State.buildings[hqId] = {
    id: hqId, ownerId: localPlayerId, type: "commandCenter",
    x: 300, y: 300, hp: BuildingDefs.commandCenter.hp, maxHp: BuildingDefs.commandCenter.hp,
    rallyX: 380, rallyY: 380, buildQueue: [],
  };

  // ПРАВКА (по прямому запросу пользователя: "пусть в начале не будет
  // построено здание добытчик, а сам штаб выполняет эту роль") — раньше
  // тут (ИИ №29) ставилась отдельная стартовая refinery рядом со штабом
  // (замена убранного юнита-рабочего). Теперь штаб САМ несёт
  // incomePerTick (см. BuildingDefs.commandCenter, 01-config-state.js) —
  // отдельное здание-добытчик на старте больше не создаётся. Игрок
  // по-прежнему может построить refinery вручную позже как обычное
  // здание (BuildingDefs.refinery никуда не делось) — изменился только
  // старт партии, не сама механика/здание.
}

// ИИ №29: seedResourceNodes() и State.resources оставлены как единственная
// точка входа, которую вызывает 13-bootstrap.js (не переименовываю имя
// функции, чтобы не трогать порядок init() в 13-bootstrap.js) — но узлы
// ресурсов больше НИКЕМ не используются игровой логикой (добыча теперь
// полностью пассивна через refinery, см. 07-game-loop-combat.js). Функция
// оставлена ПУСТОЙ, а не удалена: 13-bootstrap.js по-прежнему её вызывает,
// удаление сломало бы порядок <script> без правки другого файла.
function seedResourceNodes() {
  // намеренно ничего не делает — см. комментарий выше.
}
