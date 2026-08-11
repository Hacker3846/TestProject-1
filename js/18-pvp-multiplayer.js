/* ---------------------------- Мультиплеер PvP (ИИ №30) ---------------------------- */
// ЧТО ДЕЛАЕТ ЭТОТ ФАЙЛ:
//  1) Экран выбора режима ДО #enemySelectScreen: "Игрок против ИИ" (старое
//     поведение, ничего не меняется, просто пропускает выбор дальше на 10b)
//     или "Игрок против игрока" (PvP по 3-значному коду комнаты, который
//     оба игрока вводят вручную одинаковым — договорённость вне игры, без
//     отдельного лобби/списка комнат, см. ответ пользователя в задаче).
//  2) В PvP-режиме — материализация юнитов/зданий РЕАЛЬНОГО оппонента
//     напрямую в State.units/State.buildings (не только в remoteGhosts,
//     как раньше). Это ключевой трюк: 07-game-loop-combat.js (бой,
//     patфайндинг-занятость), 09-input.js (выделение/приказ атаки),
//     08-render.js (полноценная отрисовка по типу, не серая тень) уже
//     работают по критерию `ownerId !== localPlayerId` = враг — их
//     трогать НЕ пришлось вообще, симметричный бой работает "бесплатно"
//     сразу же, как только вражеский юнит появляется в State с валидным
//     type/ownerId.
//
// АВТОРИТЕТНОСТЬ (см. футер 11-networking.js — "MVP, не авторитетный
// сервер", это осознанно и не меняется этим файлом): КАЖДЫЙ клиент
// авторитетен только над СВОИМИ юнитами/зданиями. Урон, который наносят
// remote-юниты моим войскам, считает МОЙ клиент (через обычный
// updateCombat/updateDefensiveStructures — remote-юнит для него ничем не
// отличается от enemy_ai) и НЕМЕДЛЕННО отражается на hp моего юнита у меня
// в State — это авторитетно. Симметрично, урон, который наносят МОИ войска
// remote-юниту, считается на МОЁМ клиенте локально (визуально/для фидбека),
// но НЕ является источником истины для hp этого юнита — источник истины по
// remote-юниту это снапшот, который шлёт САМ его владелец (11-networking.js,
// myPlayerRef.set(...)). Каждый gameTick remote-объекты в State
// принудительно синхронизируются (позиция+hp) с последним полученным
// снапшотом оппонента (см. syncRemoteObjectsFromGhosts ниже) — это тот
// самый "разрешение конфликтов = синхронизация к состоянию хозяина",
// который и делает бой в итоге согласованным у обеих сторон, ценой
// небольшой задержки (~250мс троттлинг отправки в 11-networking.js).
// Если remote-юнит исчезает из снапшота оппонента (хозяин уже посчитал
// его убитым у себя) — удаляем его и локально через killUnit/killBuilding,
// чтобы получить те же визуальные эффекты смерти (08-render.js хук).

const REMOTE_OBJ_PREFIX = "__remote__"; // префикс id локальной копии, чтобы не путать с обычным uid()

// ИЗВЕСТНОЕ ОГРАНИЧЕНИЕ: renderRemoteGhosts() (08-render.js) по-прежнему
// рисует те же самые State.remoteGhosts как полупрозрачные синие силуэты
// ПОВЕРХ полноценных материализованных юнитов/зданий из этого файла —
// в PvP выглядит как лёгкий двойной контур. Не правил 08-render.js ради
// этого (не было явного сигнала трогать рендер, только "сперва
// мультиплеер"), визуально не критично для MVP. Если следующему ИИ дадут
// 08-render.js — самое чистое решение: в render() пропускать вызов
// renderRemoteGhosts() целиком, когда MultiplayerMode.mode==="pvp"
// (полноценные копии из этого файла делают тени избыточными).

/* ---------------------------- Экран выбора режима ---------------------------- */

function setupPvpModeScreen() {
  const screen = document.getElementById("pvpModeScreen");
  const aiBtn = document.getElementById("pvpModeAiBtn");
  const pvpBtn = document.getElementById("pvpModePvpBtn");
  const codeBlock = document.getElementById("pvpRoomCodeBlock");
  const codeInput = document.getElementById("pvpRoomCodeInput");
  const startBtn = document.getElementById("pvpModeStartBtn");
  const waitBlock = document.getElementById("pvpWaitBlock");
  if (!screen) {
    // Разметка почему-то отсутствует — не блокируем игру, ведём себя как
    // старое поведение (сразу режим "ai", экран сложности/фракции как раньше).
    return false;
  }

  // ИИ №30: сигнал для 13-bootstrap.js — не автозапускать старый поток
  // setupEnemySelectScreen(startGameAfterSelection) при загрузке скрипта,
  // этот файл сам решает, когда его звать (см. обработчик startBtn ниже).
  window.__pvpModeScreenActive = true;

  let chosenMode = null;

  function selectMode(mode) {
    chosenMode = mode;
    aiBtn.classList.toggle("active", mode === "ai");
    pvpBtn.classList.toggle("active", mode === "pvp");
    codeBlock.classList.toggle("show", mode === "pvp");
    updateStartEnabled();
  }

  function updateStartEnabled() {
    if (chosenMode === "ai") { startBtn.disabled = false; return; }
    if (chosenMode === "pvp") { startBtn.disabled = !/^\d{3}$/.test(codeInput.value.trim()); return; }
    startBtn.disabled = true;
  }

  aiBtn.addEventListener("click", () => selectMode("ai"));
  pvpBtn.addEventListener("click", () => selectMode("pvp"));
  codeInput.addEventListener("input", () => {
    // только цифры, максимум 3 символа
    codeInput.value = codeInput.value.replace(/\D/g, "").slice(0, 3);
    updateStartEnabled();
  });

  startBtn.addEventListener("click", () => {
    if (chosenMode === "ai") {
      MultiplayerMode.mode = "ai";
      screen.style.display = "none";
      // Дальше — старый поток: #enemySelectScreen (сложность/фракция),
      // см. 13-bootstrap.js/10b — ничего не меняем, просто пропускаем.
      if (typeof setupEnemySelectScreen === "function") {
        setupEnemySelectScreen(startGameAfterSelection);
      } else {
        startGameAfterSelection();
      }
      return;
    }
    // PvP: код уже провалидирован (3 цифры) через updateStartEnabled.
    MultiplayerMode.mode = "pvp";
    MultiplayerMode.pvpRoomCode = codeInput.value.trim();
    roomId = "pvp-" + MultiplayerMode.pvpRoomCode; // ИИ №30: переиспользуем roomId (01-config-state.js) —
                                                     // 11-networking.js строит roomRef от него без правок.
    startBtn.disabled = true;
    codeInput.disabled = true;
    waitBlock.classList.add("show");
    waitBlock.textContent = "Ожидание соперника в комнате " + MultiplayerMode.pvpRoomCode + "…";
    // ИИ №44: БАГФИКС по прямому запросу пользователя ("матч начинается не
    // сразу, а когда соперник войдёт в игру") — раньше здесь сразу шло
    // screen.style.display="none" + startGameAfterSelection(), т.е. локальный
    // матч (тик, экономика, стройка) стартовал НЕМЕДЛЕННО после ввода кода,
    // даже если в комнате ещё никого нет — waitBlock показывался буквально
    // на один кадр и тут же исчезал вместе со всем экраном режима. Теперь
    // экран ожидания остаётся на месте (screen НЕ скрывается здесь), и матч
    // реально не запускается, пока в комнате не появится второй игрок — см.
    // waitForOpponentThenStart() ниже.
    // #enemySelectScreen по-прежнему прячем сразу (см. ИИ №37 выше) — это не
    // связано с ожиданием соперника, он просто не нужен в PvP независимо от
    // его наличия.
    const staleEnemySelectScreen = document.getElementById("enemySelectScreen");
    if (staleEnemySelectScreen) staleEnemySelectScreen.style.display = "none";
    // В PvP пропускаем ЛОГИКУ выбора сложности/фракции (не имеет смысла без
    // ИИ) — но САМ старт (startGameAfterSelection) откладываем до момента,
    // когда соперник реально подключится к той же комнате (см. функцию
    // ниже) — раньше это было прокомментировано как "фича" (строить
    // экономику в одиночку, пока ждёшь), прямой запрос пользователя это
    // отменяет: теперь это ожидание, а не игра в одиночку.
    waitForOpponentThenStart(screen, waitBlock);
  });

  return true;
}

// ИИ №44: ждём, пока в комнате появится СОПЕРНИК (не мы сами), прежде чем
// реально стартовать локальный матч. Пишем лёгкий presence-маркер напрямую
// через db (объявлен в 01-config-state.js, доступен глобально) — НЕ через
// players/{id} (это позже, из setupNetworking()/11-networking.js, которая
// сама вызывается только из init()/startGameAfterSelection() — то есть уже
// ПОСЛЕ момента, который мы сейчас как раз откладываем; presence — намеренно
// отдельная, более ранняя и лёгкая ветка той же комнаты). Симметрично для
// обеих сторон: кто бы ни зашёл вторым, оба клиента увидят в presence-листе
// больше одного id и оба стартуют почти одновременно.
function waitForOpponentThenStart(screen, waitBlock) {
  const activeRoomId = roomId; // уже выставлен на "pvp-XXX" выше по клику
  const presenceRef = db.ref(`generals_rooms/${activeRoomId}/presence/${localPlayerId}`);
  presenceRef.set({ joinedAt: Date.now() }).catch(() => { /* офлайн — молча, как и остальной сетевой код проекта */ });
  presenceRef.onDisconnect().remove();

  const roomPresenceRef = db.ref(`generals_rooms/${activeRoomId}/presence`);
  const onPresenceChange = (snap) => {
    const data = snap.val() || {};
    const opponentJoined = Object.keys(data).some((pid) => pid !== localPlayerId);
    if (!opponentJoined) return;

    roomPresenceRef.off("value", onPresenceChange);
    // Свою presence-запись убираем явно (а не только через onDisconnect) —
    // с этого момента источник истины по нашему присутствию в комнате это
    // players/{id} (11-networking.js, начнётся через startGameAfterSelection
    // ниже), presence-ветка была нужна только для этого рукопожатия.
    presenceRef.onDisconnect().cancel();
    presenceRef.remove().catch(() => {});

    if (waitBlock) waitBlock.textContent = "Соперник найден — старт боя…";
    // Короткая пауза, чтобы игрок успел увидеть сообщение "соперник найден"
    // — иначе оно мелькнёт быстрее, чем читается (симметрично на обеих
    // сторонах, т.к. оба клиента получают presence-обновление независимо).
    setTimeout(() => {
      if (screen) screen.style.display = "none";
      startGameAfterSelection();
    }, 400);
  };
  roomPresenceRef.on("value", onPresenceChange);
}

// Если разметка отсутствует — сразу отдаём управление старому потоку
// (то же поведение, что и раньше, до этого файла).
if (!setupPvpModeScreen()) {
  if (typeof setupEnemySelectScreen === "function") {
    setupEnemySelectScreen(() => { if (typeof startGameAfterSelection === "function") startGameAfterSelection(); });
  }
}

/* ---------------------------- PvP-синхронизация боя ---------------------------- */

// Вызывается ОДИН раз из 13-bootstrap.js/init(), только если MultiplayerMode.mode==="pvp".
function initPvpMultiplayer() {
  const netStatusEl = document.getElementById("netStatus");
  const enemyLabelEl = document.getElementById("enemyLabel");
  const enemySwatchEl = document.getElementById("enemySwatch");
  if (enemyLabelEl) enemyLabelEl.textContent = "Ожидание соперника…";

  logMsg(`PvP: комната ${MultiplayerMode.pvpRoomCode}. Ждём соперника…`);

  // Каждый gameTick (см. хук ниже) материализуем/синхронизируем remote-объекты
  // из State.remoteGhosts (заполняется 11-networking.js, читать который не
  // пришлось трогать вообще — он уже писал ровно то, что нужно).
  (function hookGameTickForPvpSync() {
    const _gameTick = gameTick;
    gameTick = function (dtMs) {
      _gameTick(dtMs);
      syncRemoteObjectsFromGhosts();
    };
  })();

  function syncRemoteObjectsFromGhosts() {
    const ghosts = State.remoteGhosts || {};
    const opponentEntries = Object.entries(ghosts);

    // Обнаружение соперника (первый живой remote-игрок в комнате) — один раз
    // пишем его id/цвет в HUD, чтобы "Ожидание соперника…" сменилось на факт.
    if (!MultiplayerMode.opponentId && opponentEntries.length > 0) {
      const [pid] = opponentEntries[0];
      MultiplayerMode.opponentId = pid;
      // ИИ №36: БАГФИКС — для соперника нигде не создавался State.players[pid],
      // из-за этого drawBuilding/drawUnit (08-render.js) не находили player.color
      // и рисовали его юниты/здания фолбэк-цветом (#888/#fff, серый/белый) —
      // визуально сливалось с нейтральным фоном, легко принять за "не работает".
      // credits/power тут декоративны (не влияют на бой — соперник ведёт свою
      // экономику на своём клиенте), нужен только color для рендера.
      if (!State.players[pid]) {
        State.players[pid] = { id: pid, credits: 0, power: 0, powerUse: 0, color: "#8a2a1f", side: "enemy" };
      }
      if (enemyLabelEl) enemyLabelEl.textContent = pid;
      logMsg("PvP: соперник подключился — " + pid, "enemy");
    }

    const seenRemoteIds = new Set();

    opponentEntries.forEach(([pid, pdata]) => {
      if (!pdata) return;

      // ИИ №30: 11-networking.js кладёт исходный id ЮНИТА/ЗДАНИЯ как КЛЮЧ
      // объекта (myUnits[u.id] = {type,x,y,hp}), не как поле внутри значения
      // — используем Object.entries и берём id из ключа, не из ru.id
      // (которого там нет и не будет без правки 11, трогать которую не
      // требуется).
      Object.entries(pdata.units || {}).forEach(([remoteUnitId, ru]) => {
        if (!ru) return;
        const localId = REMOTE_OBJ_PREFIX + remoteUnitId;
        seenRemoteIds.add(localId);
        const def = UnitDefs[ru.type];
        if (!def) return; // неизвестный/устаревший тип — пропускаем, не роняем игру

        let u = State.units[localId];
        if (!u) {
          u = State.units[localId] = {
            id: localId, ownerId: pid, type: ru.type,
            x: ru.x, y: ru.y, targetX: null, targetY: null,
            hp: ru.hp, maxHp: def.maxHp, state: "idle", cargo: 0,
            attackTargetId: null, attackCooldownLeft: 0, attackMoveMode: false,
            attackMoveHomeX: null, attackMoveHomeY: null,
            remote: true, // ИИ №30: маркер — этот объект не мутируется физикой/боем
                           // авторитетно, только зеркалирует хозяина (см. блок ниже)
          };
        } else {
          // Авторитет хозяина: позиция/hp принудительно подтягиваются к
          // последнему снапшоту КАЖДЫЙ тик — локальный бой мог что-то
          // насчитать иначе, но источник истины по чужому юниту это его
          // владелец, не мы (см. комментарий-обоснование в шапке файла).
          u.x = ru.x; u.y = ru.y; u.hp = ru.hp;
        }
      });

      Object.entries(pdata.buildings || {}).forEach(([remoteBId, rb]) => {
        if (!rb) return;
        const localId = REMOTE_OBJ_PREFIX + remoteBId;
        seenRemoteIds.add(localId);
        const def = BuildingDefs[rb.type];
        if (!def) return;

        let b = State.buildings[localId];
        if (!b) {
          b = State.buildings[localId] = {
            id: localId, ownerId: pid, type: rb.type,
            x: rb.x, y: rb.y, hp: rb.hp, maxHp: def.maxHp,
            rallyX: rb.x, rallyY: rb.y, buildQueue: [],
            remote: true,
          };
        } else {
          b.hp = rb.hp; // здания не двигаются — только hp подтягиваем
        }
      });
    });

    // Юнит/здание пропал из снапшота хозяина => хозяин уже посчитал его
    // убитым у себя. Убиваем локальную копию тем же путём (killUnit/
    // killBuilding), чтобы получить те же визуальные эффекты смерти
    // (08-render.js хук на killUnit/killBuilding) вместо немого delete.
    Object.keys(State.units).forEach(id => {
      if (!id.startsWith(REMOTE_OBJ_PREFIX)) return;
      if (!seenRemoteIds.has(id) && State.units[id]) killUnit(id);
    });
    Object.keys(State.buildings).forEach(id => {
      if (!id.startsWith(REMOTE_OBJ_PREFIX)) return;
      if (!seenRemoteIds.has(id) && State.buildings[id]) killBuilding(id);
    });
  }
}
