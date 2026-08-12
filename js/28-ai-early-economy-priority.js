/* ---------------------------- ИИ №50: в начале партии — в доход, не в стены ---------------------------- */
// Прямой запрос пользователя: "чтобы ии в начале тратился не на стены, а на
// больший доход". Сессия ИИ №48 (26-ai-defense-economy-throttle.js) уже
// привязала РОСТ обороны к причине (enemyDefenseJustified) — без причины
// оборона не растёт выше "базового" уровня (стены 16/40, турели 4/10).
// Этот файл добавляет ЕЩЁ ОДИН, более ранний по времени партии порог СВЕРХУ
// уже существующего: пока экономика ИИ ещё не встала на ноги (refinery
// меньше цели, см. ENEMY_REFINERY_TARGET, 06-enemy-ai.js), оборона урезается
// ЕЩЁ ниже базового уровня 26-й сессии — почти до нуля, но не до нуля,
// чтобы база не выглядела совсем голой при самом первом визите разведчика.
// Если экономика уже разогналась (refinery на месте) — потолок возвращается
// к обычной логике 26-й сессии без изменений.
//
// ДИАГНОЗ (по факту чтения кода, не с потолка): ИИ №48 привязал РОСТ обороны
// к причине, но НЕ к времени партии/состоянию экономики — на самом старте
// партии, пока refinery ещё не построена ни одна (доход идёт только от
// штаба, см. initEnemyStub/06-enemy-ai.js), "базовый уровень" (16 стен и
// 4 турели, оба не бесплатны — 40+350кр за штуку) всё равно доступен для
// траты сразу, как только у ИИ появляются первые лишние кредиты, задерживая
// именно то накопление на refinery, о котором просит пользователь. Первая
// refinery (базовая цена, см. BuildingDefs.refinery, 01-config-state.js)
// должна появляться раньше первой стены/турели просто по порядку трат, а не
// конкурировать с ними за один и тот же ранний излишек кредитов.
//
// ВАЖНО: enemyEconomyStep (актуальная версия — 21-ai-base-strategy.js) УЖЕ
// строит refinery третьим приоритетом (после powerPlant/barracks, до
// warFactory/turret/army) — это НЕ трогаем и не дублируем, экономика и так
// приоритетна ВНУТРИ enemyEconomyStep. Проблема была в другом: enemyWallStep
// (18/19-...js) и enemyMortarAndMineStep (25/26-...js) — ОТДЕЛЬНЫЕ от
// enemyEconomyStep decision-тик-функции (свои троттлинг-таймеры, вызываются
// параллельно, не после неё) — тратят из ТОГО ЖЕ кошелька ИИ независимо от
// того, достроена ли уже экономика. Раз обе стороны тратят из одного пула
// кредитов на разные вещи в один и тот же тик, кредитов на refinery
// объективно физически не хватает, пока часть уходит стенам/турелям —
// именно это и наблюдается как "ИИ тратится на стены, а не на доход".
//
// Архитектура (тот же приём "переопределение после объявления", что и весь
// проект) — НОВЫЙ файл, ничего из 06/18/19/21/25/26 не редактируется:
//  1) enemyEconomyRampedUp() — своя, ДОПОЛНИТЕЛЬНАЯ функция: истина, если
//     refinery уже на уровне цели (ENEMY_REFINERY_TARGET, 06-enemy-ai.js).
//     НЕ трогает enemyDefenseJustified/enemyThreatMemory (26-...js) —
//     ортогональный критерий (не "есть ли угроза", а "встала ли экономика
//     на ноги"), поэтому отдельная функция, а не вариация готовой.
//  2) enemyWallTarget/enemyTurretTarget оборачиваются ЕЩЁ РАЗ (патч поверх
//     уже патченных 26-й сессией версий — порядок подключения, ПОСЛЕ
//     26-ai-defense-economy-throttle.js, это гарантирует): пока экономика
//     не разогналась и нет оправданной причины защищаться — потолок
//     дополнительно урезается до ENEMY_WALL_EARLY_CAP/ENEMY_TURRET_EARLY_CAP
//     (меньше базового уровня 26-й сессии). enemyDefenseJustified()
//     ПО-ПРЕЖНЕМУ может пробить этот урезанный потолок вверх (до полного
//     значения, минуя даже базовый уровень) — реальная угроза на раннем
//     этапе партии не должна оставлять базу совсем без обороны.
//  3) enemyMortarAndMineStep — та же идея, целиком переопределённая копия
//     (как и в 26-...js, тот же довод — функция не параметризована по
//     раннему порогу, дешевле скопировать тело с готовыми порогами, чем
//     рефакторить чужой файл ради одной проверки).
// Подключать ПОСЛЕДНИМ в index.html, ПОСЛЕ js/26-ai-defense-economy-throttle.js
// (и после моего же js/27-ai-active-defense-tactics.js, порядок между ними
// не важен — 27 не трогает wall/turret/mortar-target функции вообще).

/* ==================================================================
   ЧАСТЬ 1: "разогналась ли экономика" — свой, ортогональный критерий
   ================================================================== */

// Истина, если число refinery ИИ уже на уровне цели сложности/фракции
// (ENEMY_REFINERY_TARGET, 06-enemy-ai.js — та же цель, которой уже
// добивается enemyEconomyStep, читаем как единый источник истины, а не
// вводим свою копию числа). Специально НЕ требуем "все построены", только
// "цель достигнута" — на easy/некоторых фракциях цель может быть низкой,
// это нормально, экономика считается разогнанной по тем же меркам, что уже
// использует сам ИИ для решения "хватит строить refinery, что дальше".
function enemyEconomyRampedUp() {
  const refineryCount = enemyBuildings().filter(b => b.type === "refinery").length;
  return refineryCount >= ENEMY_REFINERY_TARGET();
}

/* ==================================================================
   ЧАСТЬ 2: стены/турели — ранний потолок ниже базового уровня 26-й сессии
   ================================================================== */
// Оба меньше соответствующих ENEMY_WALL_BASELINE_CAP(16)/
// ENEMY_TURRET_BASELINE_CAP(4) из 26-ai-defense-economy-throttle.js — не
// ноль намеренно (совсем без обороны на самом старте партии выглядело бы
// как баг, а не как "экономика в приоритете"), просто заметно меньше, пока
// доход ещё не разогнан.
const ENEMY_WALL_EARLY_CAP = 4;
const ENEMY_TURRET_EARLY_CAP = 1;

(function patchEnemyWallTargetForEarlyEconomy() {
  if (typeof enemyWallTarget !== "function") return;
  const _enemyWallTargetAfterThrottle = enemyWallTarget; // уже пропатченная версия 26-й сессии
  enemyWallTarget = function () {
    const afterThrottle = _enemyWallTargetAfterThrottle();
    // enemyDefenseJustified() (26-...js, читаем как есть, не дублируем) —
    // реальная угроза пробивает даже ранний потолок, база не должна
    // остаться совсем беззащитной, если враг напал именно в первые секунды.
    if (enemyEconomyRampedUp() || enemyDefenseJustified()) return afterThrottle;
    return Math.min(afterThrottle, ENEMY_WALL_EARLY_CAP);
  };
})();

(function patchEnemyTurretTargetForEarlyEconomy() {
  if (typeof enemyTurretTarget !== "function") return;
  const _enemyTurretTargetAfterThrottle = enemyTurretTarget; // уже пропатченная версия 26-й сессии
  enemyTurretTarget = function () {
    const afterThrottle = _enemyTurretTargetAfterThrottle();
    if (enemyEconomyRampedUp() || enemyDefenseJustified()) return afterThrottle;
    return Math.min(afterThrottle, ENEMY_TURRET_EARLY_CAP);
  };
})();

/* ==================================================================
   ЧАСТЬ 3: мортира/мина — та же идея, целиком переопределённая копия
   (обоснование копирования целиком — см. тот же довод в 26-...js)
   ================================================================== */
(function patchEnemyMortarAndMineStepForEarlyEconomy() {
  if (typeof enemyMortarAndMineStep !== "function") return;
  if (typeof MORTAR_LIMIT_PER_PLAYER === "undefined" || typeof ENEMY_MINE_TARGET === "undefined") return;

  const ENEMY_MORTAR_EARLY_CAP = 0; // мортира — дорогая (BuildingDefs.mortar.cost) наступательно-оборонительная постройка, на самом старте партии не нужна вообще
  const ENEMY_MINE_EARLY_CAP = 1;

  enemyMortarAndMineStep = function () {
    if (enemyFsm.phase === "ATTACK") return; // та же граница, что и раньше (25/26-...js)
    const player = State.players[enemyPlayerId];
    if (!player) return;
    const hasBarracks = enemyBuildings().some(b => b.type === "barracks");
    const hasTurret = enemyBuildings().some(b => b.type === "turret");
    if (!hasBarracks || !hasTurret) return;

    const rampedOrJustified = enemyEconomyRampedUp() || enemyDefenseJustified();
    const justified = enemyDefenseJustified();

    // Полный/базовый потолок (как решила 26-я сессия) — снаружи неизменны;
    // здесь дополнительно урезаем их ЕЩЁ раз, если экономика не разогналась
    // И нет оправданной причины.
    const mortarBaselineCap = justified ? MORTAR_LIMIT_PER_PLAYER : Math.min(MORTAR_LIMIT_PER_PLAYER, 1 /* ENEMY_MORTAR_BASELINE_CAP, 26-...js */);
    const mortarCap = rampedOrJustified ? mortarBaselineCap : Math.min(mortarBaselineCap, ENEMY_MORTAR_EARLY_CAP);
    if (countOwnerMortars(enemyPlayerId) < mortarCap && player.credits >= BuildingDefs.mortar.cost) {
      enemyPlaceBuilding("mortar");
      return;
    }

    const mineBaselineCap = justified ? ENEMY_MINE_TARGET : Math.min(ENEMY_MINE_TARGET, 2 /* ENEMY_MINE_BASELINE_CAP, 26-...js */);
    const mineCap = rampedOrJustified ? mineBaselineCap : Math.min(mineBaselineCap, ENEMY_MINE_EARLY_CAP);
    const mineCount = enemyBuildings().filter(b => b.type === "landmine").length;
    if (mineCount < mineCap && player.credits >= BuildingDefs.landmine.cost) {
      enemyPlaceBuilding("landmine");
    }
  };
})();

/* ---------------------------- ПРИМЕЧАНИЕ ----------------------------
   ENEMY_MORTAR_BASELINE_CAP(1)/ENEMY_MINE_BASELINE_CAP(2) из 26-...js
   объявлены ВНУТРИ её IIFE (приватные, не видны глобально) — пришлось
   продублировать сами ЧИСЛА как инлайн-константы с комментарием-ссылкой,
   а не импортировать переменные (недоступны). Если 26-...js когда-нибудь
   изменит эти два числа — синхронизировать вручную здесь же. Публичные
   ENEMY_WALL_BASELINE_CAP/ENEMY_TURRET_BASELINE_CAP такой проблемы не
   создают (они объявлены на верхнем уровне модуля 26-...js, глобальны) —
   поэтому для стен/турелей выше читается результат уже пропатченной
   функции целиком (_enemyWallTargetAfterThrottle()), а не число напрямую,
   и переприкладывать вторую копию порога не потребовалось. */
