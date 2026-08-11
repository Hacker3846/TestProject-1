/* ---------------------------- Рандомный спавн по углам карты (ИИ №35) ---------------------------- */
// ЗАДАЧА ПОЛЬЗОВАТЕЛЯ: "добавь мультиплеер, добавь рандомный спавн (на 4
// углах карты) у игрока и у врага (ИИ или второй игрок), не спавни врагов
// в одном и том же углу". Мультиплеер (PvP) уже был начат раньше
// (js/18-pvp-multiplayer.js, js/11-networking.js) — багфикс самого PvP
// (roomRef был привязан к устаревшей roomId) сделан ПРЯМОЙ правкой
// js/11-networking.js (см. комментарий там), это отдельный баг, не про
// спавн. Этот файл — только про углы, по установленному в проекте приёму:
// новая фича отдельным файлом, который патчит уже объявленные функции
// (initLocalPlayer, initEnemyStub, startGameAfterSelection) ПОСЛЕ их
// объявления. Подключён последним (после 19) — все патчимые функции к
// этому моменту точно объявлены, включая цепочку патчей 15/18 поверх них.
//
// ЛОГИКА ВЫБОРА УГЛОВ:
//  - Режим "ai" (js/13-bootstrap.js вызывает и initLocalPlayer(), и
//    initEnemyStub() локально, синхронно, без сети) — выбираем СРАЗУ 2
//    РАЗНЫХ угла из 4 (Fisher–Yates, см. shuffleCorners) прямо в патче
//    startGameAfterSelection(), до вызова оригинала. Гарантия "не тот же
//    угол" тривиальна — оба индекса берутся из одной перестановки.
//  - Режим "pvp" — у КАЖДОГО клиента нет заранее известного оппонента,
//    поэтому нельзя просто "выбрать 2 разных угла" локально. Вместо этого
//    угол — это АТОМАРНАЯ заявка через Firebase-транзакцию на узел
//    generals_rooms/{roomId}/corners/{idx} (см. claimSpawnCorner ниже):
//    пробуем случайный порядок углов, занимаем первый свободный. Так как
//    transaction() в RTDB атомарна и видит актуальное значение узла, два
//    реальных клиента в одной комнате физически не могут одновременно
//    занять один и тот же угол — kто раньше закоммитил, тот его и получил,
//    второй увидит отказ (committed=false) и попробует следующий угол.
//    Угол ОППОНЕНТА нам знать не нужно: он сам разместит свои здания у
//    себя дома в свой угол и пришлёт их x/y в обычном снапшоте
//    (js/11-networking.js) — 18-pvp-multiplayer.js материализует их уже
//    с правильными координатами, никакого дополнительного согласования
//    не требуется.
//  - onDisconnect().remove() на занятый узел угла — чтобы при выходе
//    игрока (или при повторном использовании того же 3-значного кода
//    комнаты следующей парой игроков) угол не оставался занятым навечно.
//    Тот же приём, что уже применён к myPlayerRef в 11-networking.js.

/* ---------------------------- Геометрия углов ---------------------------- */

function mapWidthPx() { return GameConfig.mapTilesW * GameConfig.tileSize; }
function mapHeightPx() { return GameConfig.mapTilesH * GameConfig.tileSize; }

// Отступ штаба от края карты. 300/300 — те же числа, что раньше были
// хардкодом позиции игрока (js/05-init-world.js) в углу 0, так что угол 0
// после патча выглядит так же, как и раньше (не только "новый" рандом, но
// и старое поведение остаётся одним из 4 равновероятных исходов).
const CORNER_MARGIN_X = 300;
const CORNER_MARGIN_Y = 300;

// Смещения зданий/юнита от штаба — ВСЕГДА направлены "к центру карты" (см.
// signX/signY ниже), чтобы после мирроринга по углам ничего не вылезало
// за карту и не накладывалось на соседние клетки застройки.
const CORNER_REFINERY_OFFSET = { x: 120, y: 45 };
const CORNER_RALLY_HQ_OFFSET = { x: 90, y: 90 };
const CORNER_RALLY_REFINERY_OFFSET = { x: 40, y: 40 };
const CORNER_STARTER_UNIT_OFFSET = { x: 70, y: -20 }; // только для стартового rifleman ИИ (initEnemyStub)

// 0 = верхний левый, 1 = верхний правый, 2 = нижний левый, 3 = нижний правый.
const CORNER_SIGNS = [
  { signX: 1, signY: 1 },
  { signX: -1, signY: 1 },
  { signX: 1, signY: -1 },
  { signX: -1, signY: -1 },
];

function cornerLayout(idx) {
  const { signX, signY } = CORNER_SIGNS[idx];
  const hqX = signX > 0 ? CORNER_MARGIN_X : mapWidthPx() - CORNER_MARGIN_X;
  const hqY = signY > 0 ? CORNER_MARGIN_Y : mapHeightPx() - CORNER_MARGIN_Y;
  return {
    hq: { x: hqX, y: hqY },
    refinery: {
      x: hqX + signX * CORNER_REFINERY_OFFSET.x,
      y: hqY + signY * CORNER_REFINERY_OFFSET.y,
    },
    rallyHq: {
      x: hqX + signX * CORNER_RALLY_HQ_OFFSET.x,
      y: hqY + signY * CORNER_RALLY_HQ_OFFSET.y,
    },
    rallyRefinery: {
      x: hqX + signX * CORNER_REFINERY_OFFSET.x + signX * CORNER_RALLY_REFINERY_OFFSET.x,
      y: hqY + signY * CORNER_REFINERY_OFFSET.y + signY * CORNER_RALLY_REFINERY_OFFSET.y,
    },
    starterUnit: {
      x: hqX + signX * CORNER_STARTER_UNIT_OFFSET.x,
      y: hqY + signY * CORNER_STARTER_UNIT_OFFSET.y,
    },
  };
}

function shuffleCorners(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

// Единственный источник истины о том, кто в каком углу стартует в ЭТОЙ
// партии. local — всегда наш угол. enemy — угол бота, актуален ТОЛЬКО в
// режиме "ai" (в "pvp" врага размещает его же собственный клиент у себя).
const AssignedCorners = { local: null, enemy: null };

/* ---------------------------- PvP: атомарная заявка угла ---------------------------- */

// Возвращает Promise<number> — индекс занятого угла (0..3). roomId к
// моменту вызова уже финален (js/18-pvp-multiplayer.js выставляет
// "pvp-XXX" СИНХРОННО, до вызова startGameAfterSelection(), см. патч
// ниже) — поэтому свежий db.ref(...) здесь безопасен и не зависит от
// того, успел ли уже отработать setupNetworking() (он ещё не вызывался,
// он часть init(), а мы вклиниваемся ДО init()).
// ИИ №37: БАГФИКС — прямой репорт пользователя "жму против игрока, друг
// тоже пишет тот же код — игра вообще не начинается" (не "не вижу друга",
// а именно пустой/чёрный экран, партия не стартует ВООБЩЕ, даже локально
// в одиночку). Причина: у Promise в claimSpawnCorner() не было ни reject,
// ни таймаута — если .transaction() хотя бы на ОДНОМ вызове ни разу не
// вызовет свой completion-коллбэк (обрыв/задержка соединения, устройство
// временно offline, правила Firebase молча блокируют запись именно в
// generals_rooms/{roomId}/corners — неважно, ПРИЧИНА тут может быть любая
// внешняя), tryNext() просто не продвигается — promise висит молча
// НАВСЕГДА, ни .then(), ни .catch() в патче startGameAfterSelection
// (ниже) не срабатывают. init() (= канвас, requestAnimationFrame(loop))
// при этом ещё не вызывался — экран уже пуст (#pvpModeScreen скрывается
// в 18-pvp-multiplayer.js ДО вызова startGameAfterSelection), в консоли
// при этом ни одной ошибки — выглядит как "игра вообще не начинается"
// без единой зацепки.
// Фикс: жёсткий таймаут CORNER_CLAIM_TIMEOUT_MS. Если за это время НИ
// ОДНА попытка транзакции не отработала (ни committed, ни abort) — берём
// случайный угол без гарантии эксклюзивности (тот же фолбэк, что уже был
// у "все 4 угла заняты") и всё равно стартуем партию, вместо вечного
// зависания. Если транзакции в итоге всё же отработают ПОСЛЕ таймаута —
// их результат просто игнорируется (settled-флаг), партия уже пошла.
const CORNER_CLAIM_TIMEOUT_MS = 6000;

function claimSpawnCorner() {
  return new Promise((resolve) => {
    let settled = false;
    const settleOnce = (idx) => {
      if (settled) return;
      settled = true;
      resolve(idx);
    };

    const timeoutId = setTimeout(() => {
      if (typeof logMsg === "function") {
        logMsg("Не дождались подтверждения угла от сервера — стартуем без гарантии эксклюзивности.", "warn");
      }
      settleOnce(Math.floor(Math.random() * 4));
    }, CORNER_CLAIM_TIMEOUT_MS);

    const cornersRef = db.ref(`generals_rooms/${roomId}`).child("corners");
    const order = shuffleCorners([0, 1, 2, 3]);
    let i = 0;
    tryNext();

    function tryNext() {
      if (settled) return;
      if (i >= order.length) {
        // Не ожидаемый случай для 1v1 (все 4 угла кем-то заняты) — не
        // блокируем партию, берём случайный без гарантии эксклюзивности,
        // чем висеть на "Подключение…" бесконечно.
        clearTimeout(timeoutId);
        settleOnce(order[0]);
        return;
      }
      const idx = order[i++];
      cornersRef.child(String(idx)).transaction(
        (current) => {
          if (current === null || current === undefined) return localPlayerId; // свободен — занимаем
          if (current === localPlayerId) return current;                        // мы же и заняли (реконнект) — не абортим
          return; // undefined => abort: угол занят другим игроком, пробуем следующий
        },
        (error, committed) => {
          if (settled) return; // таймаут уже отработал раньше — этот результат больше не нужен
          if (!error && committed) {
            cornersRef.child(String(idx)).onDisconnect().remove();
            clearTimeout(timeoutId);
            settleOnce(idx);
          } else {
            tryNext();
          }
        }
      );
    }
  });
}

/* ---------------------------- Патч: выбор угла ДО старта партии ---------------------------- */

// Патчим startGameAfterSelection (13-bootstrap.js) — это единственная
// точка, через которую запускается init() что в режиме "ai", что в "pvp"
// (см. 18-pvp-multiplayer.js: оба ветвления startBtn.click ведут сюда).
// Оборачиваем, а не переписываем: если старт вызовут не через этот путь
// (например, разметка #pvpModeScreen отсутствует и сработал фолбэк в
// 13-bootstrap.js) — initLocalPlayer/initEnemyStub ниже сами подставят
// безопасный дефолт (угол 0 / случайный отличный угол), партия не упадёт.
(function patchStartGameAfterSelectionForCornerSpawn() {
  const _startGameAfterSelection = startGameAfterSelection;
  startGameAfterSelection = function () {
    if (typeof MultiplayerMode !== "undefined" && MultiplayerMode.mode === "pvp") {
      if (typeof logMsg === "function") logMsg("Определяем стартовый угол карты…");
      claimSpawnCorner()
        .then((idx) => { AssignedCorners.local = idx; _startGameAfterSelection(); })
        .catch(() => { AssignedCorners.local = Math.floor(Math.random() * 4); _startGameAfterSelection(); });
      return;
    }
    // Режим "ai" — оба угла решаются локально и мгновенно, сеть не нужна.
    const shuffled = shuffleCorners([0, 1, 2, 3]);
    AssignedCorners.local = shuffled[0];
    AssignedCorners.enemy = shuffled[1];
    _startGameAfterSelection();
  };
})();

/* ---------------------------- Патч: позиция игрока ---------------------------- */

(function patchInitLocalPlayerForCornerSpawn() {
  const _initLocalPlayer = initLocalPlayer;
  initLocalPlayer = function () {
    _initLocalPlayer(); // создаёт HQ/refinery по старым хардкод-координатам угла 0 — переносим ниже
    const idx = AssignedCorners.local != null ? AssignedCorners.local : 0;
    const layout = cornerLayout(idx);
    const mine = Object.values(State.buildings).filter((b) => b.ownerId === localPlayerId);
    const hq = mine.find((b) => b.type === "commandCenter");
    const ref = mine.find((b) => b.type === "refinery");
    if (hq) {
      hq.x = layout.hq.x; hq.y = layout.hq.y;
      hq.rallyX = layout.rallyHq.x; hq.rallyY = layout.rallyHq.y;
    }
    if (ref) {
      ref.x = layout.refinery.x; ref.y = layout.refinery.y;
      ref.rallyX = layout.rallyRefinery.x; ref.rallyY = layout.rallyRefinery.y;
    }
    // State.camera по умолчанию (0,0) (01-config-state.js) — раньше это
    // случайно совпадало с видом на угол 0. При спавне в любом другом углу
    // без центрирования игрок стартовал бы, глядя в пустой неисследованный
    // угол карты. Центрируем тем же расчётом, что уже использует кнопка
    // "центр" мобильного HUD (09-input.js, mobileCenterBtn).
    if (hq) {
      State.camera.x = hq.x - canvas.logicalWidth / 2;
      State.camera.y = hq.y - canvas.logicalHeight / 2;
    }
  };
})();

/* ---------------------------- Патч: позиция ИИ-противника ---------------------------- */
// В PvP initEnemyStub() вообще не вызывается (см. 13-bootstrap.js) —
// этот патч имеет эффект только в режиме "ai".

(function patchInitEnemyStubForCornerSpawn() {
  const _initEnemyStub = initEnemyStub; // ловим уже с учётом патча 15-difficulty-patch.js поверх оригинала
  initEnemyStub = function () {
    _initEnemyStub();
    let idx = AssignedCorners.enemy;
    if (idx == null || idx === AssignedCorners.local) {
      // Фолбэк на случай вызова в обход нашего патча startGameAfterSelection
      // (см. комментарий там) — берём любой угол, гарантированно отличный
      // от игрока, а не просто случайный из всех четырёх.
      const candidates = [0, 1, 2, 3].filter((c) => c !== AssignedCorners.local);
      idx = candidates[Math.floor(Math.random() * candidates.length)];
      AssignedCorners.enemy = idx;
    }
    const layout = cornerLayout(idx);
    const hq = Object.values(State.buildings).find((b) => b.ownerId === enemyPlayerId && b.type === "commandCenter");
    const ref = Object.values(State.buildings).find((b) => b.ownerId === enemyPlayerId && b.type === "refinery");
    const starter = Object.values(State.units).find((u) => u.ownerId === enemyPlayerId);
    if (hq) {
      hq.x = layout.hq.x; hq.y = layout.hq.y;
      hq.rallyX = layout.rallyHq.x; hq.rallyY = layout.rallyHq.y;
    }
    if (ref) {
      ref.x = layout.refinery.x; ref.y = layout.refinery.y;
      ref.rallyX = layout.rallyRefinery.x; ref.rallyY = layout.rallyRefinery.y;
    }
    if (starter) {
      starter.x = layout.starterUnit.x; starter.y = layout.starterUnit.y;
    }
  };
})();

// НЕ ПРОВЕРЕНО ВЖИВУЮ (нет браузерного окружения в этой сессии — см. ту же
// оговорку у прошлых ИИ №31-34): (1) реальный 2-клиентский PvP-сценарий —
// оба берут разные углы, экономика/бой видны друг другу в правильных
// местах карты; (2) режим "ai" на всех 4 возможных парах углов — что
// здания у обеих сторон не наезжают на неисследованный край карты и
// строительная зона (isEnemyBuildPlacementValid, 06-enemy-ai.js) вокруг
// них достаточно свободна во всех 4 случаях, не только в старом углу 0.
