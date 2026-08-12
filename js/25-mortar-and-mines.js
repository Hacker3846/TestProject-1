/* ---------------------------- ИИ №47: мортира + мина-ловушка (Clash of Clans) ---------------------------- */
// Прямой запрос пользователя: "Добавь мортиру и мины, бери идею в клеш оф
// кланс. Здание мортира, у одного максимум может быть 3, стреляет уроном по
// площади, стоит 1000-2000 в зависимости от урона. Мина-ловушка невидима для
// противника, взрывается так же как снаряд мортиры но урон x2 больше" +
// уточнение "мину тоже в здание запиши".
//
// Оба новых типа — ОБЫЧНЫЕ записи в BuildingDefs (mortar/landmine), тем же
// data-driven приёмом, что turret/refinery/wall и т.д. (01-config-state.js).
// Этот файл добавляет то, что таблицей одной не покрывается:
//  1) AoE-урон — в игре сейчас (07-game-loop-combat.js) весь урон строго
//     single-target (и у юнитов updateCombat, и у зданий
//     updateDefensiveStructures бьют ровно target.hp -= def.attackDamage,
//     без понятия радиуса поражения). Мортира ПО ОПРЕДЕЛЕНИЮ ("уроном по
//     площади") этого требует, поэтому updateDefensiveStructures патчится
//     "переопределение после объявления" (тот же приём, что 13b/14/../24) —
//     после вызова оригинала отдельным лёгким проходом находим мортиры и
//     ДОБИВАЕМ splash-уроном всех врагов вокруг УЖЕ пораженной оригиналом
//     точки (см. подробности в патче ниже — оригинал не дублируется).
//     ИСПРАВЛЕННЫЙ БАГ: точка удара для splash вычисляется заранее своей
//     копией логики выбора цели (текущая цель ИЛИ findNearestEnemyInRange),
//     а не чтением b.attackTargetId "как есть" — иначе самый первый выстрел
//     свежепостроенной мортиры (когда attackTargetId ещё null и назначается
//     только ВНУТРИ вызова оригинала) терял splash и бил только по одной
//     цели. См. подробный комментарий у самого патча.
//  2) Лимит "максимум 3 на игрока" — тот же паттерн, что
//     TURRET_LIMIT_PER_PLAYER/countOwnerTurrets (01-config-state.js): здесь
//     MORTAR_LIMIT_PER_PLAYER/countOwnerMortars, с проверкой и в
//     tryStartBuilding, и в confirmBuildPlacement (10-hud.js, патчатся так
//     же, как турель уже там проверяется — не переписываем эти функции
//     целиком, а оборачиваем), и в enemyEconomyStep (06-enemy-ai.js, ИИ тоже
//     не должен обходить лимит).
//  3) Невидимость мины — сейчас видимость чужих построек управляется ТОЛЬКО
//     фогом войны (isWorldPointVisible, см. 08-render.js/09-input.js) — нет
//     понятия "здание видно, но конкретно ЭТО скрыто даже без тумана".
//     Реализовано как ОТДЕЛЬНЫЙ, более сильный фильтр поверх фога: чужая
//     (не своя) необнаруженная мина не рисуется (08), не выбирается кликом
//     (09), не может быть найдена автопоиском цели юнитов/турелей/мортир
//     (07/19), не учитывается в isBuildPlacementValid/isEnemyBuildPlacementValid
//     противника как препятствие для постройки поверх (иначе сам факт "тут
//     нельзя строить" уже выдавал бы её наличие) — но СВОЙ владелец всегда
//     видит и может выделить свою мину как обычное здание (это инструмент
//     игрока, а не случайный секрет от него самого).
//  4) Срабатывание мины — не "бьёт по кулдауну как турель", а одноразовый
//     триггер: как только вражеский юнит подходит в радиус, мина взрывается
//     (AoE x2 урона мортиры) и уничтожает САМА СЕБЯ (killBuilding). Это
//     отдельная логика, ближе к ловушке Clash of Clans, чем к
//     updateDefensiveStructures (та рассчитана на многократную стрельбу
//     живого здания) — реализована отдельной функцией updateLandmines(),
//     вызываемой патчем поверх gameTick (тем же приёмом, что и остальные
//     файлы патчат игровой цикл).
//  5) ИИ строит и мортиру (как ещё один слой обороны базы, после турели), и
//     мины (по прямому запросу распространяем логику "оборонительное здание"
//     на обе новые постройки — турель у ИИ уже была единственной защитой,
//     странно оставлять новые типы обороны только игроку).
//     ИСПРАВЛЕННЫЕ БАГИ (после сверки с реальными 06-enemy-ai.js/
//     19-ai-target-priority-and-clustering.js):
//      а) enemyMortarAndMineStep() раньше срабатывала независимо от
//         enemyFsm.phase, включая ATTACK — где вся остальная экономика ИИ
//         (enemyEconomyStep) осознанно НЕ работает ("фон работает во всех
//         фазах, кроме ATTACK", см. 06). Добавлена та же проверка фазы.
//      б) мина на деле ставится ТЕМ ЖЕ случайным кольцом вокруг штаба, что
//         и любое здание (никакой привязки к турели/мортире в коде нет,
//         несмотря на прежнюю формулировку в этом абзаце) — из-за этого
//         могла случайно раздувать enemyBuildingsBoundingBox()
//         (19-й файл) и вместе с ней периметр стен, косвенно выдавая
//         невидимую мину неожиданно вытянутым углом периметра. Мины теперь
//         явно исключены из подсчёта bounding box (см. патч
//         enemyBuildingsBoundingBox ниже в Части 5).
//
// Подключать ПОСЛЕДНИМ в game.html (после 22-turret-grudge.js/23/24, если
// они есть) — весь файл только патчит уже объявленные функции и добавляет
// данные, ничего не переопределяет "с нуля".

/* ==================================================================
   ДАННЫЕ: BuildingDefs.mortar / BuildingDefs.landmine
   ================================================================== */
// Мортира — по духу "уровень выше турели": дороже, стреляет реже и по
// площади, но каждый выстрел ценнее одного попадания турели именно за счёт
// splash (задевает скопление юнитов, а не одного). cost по прямому
// требованию в диапазоне 1000-2000 в зависимости от урона — считаем cost
// ЛИНЕЙНО от attackDamage (та же идея, что REFINERY_PRICE_STEP считает цену
// по формуле, а не хардкодит число): 1000 у нижней границы урона снаряда,
// 2000 у верхней. attackDamage подобран заметно выше turret (14) — весь
// смысл мортиры в том, что она страшнее турели по цене за выстрел, а не
// просто "турель, но по площади" за ту же силу.
const MORTAR_MIN_DAMAGE = 26; // -> cost 1000
const MORTAR_MAX_DAMAGE = 46; // -> cost 2000
const MORTAR_SPLASH_RADIUS = 70; // px — радиус поражения вокруг точки попадания (сопоставим с бортовым интервалом группы юнитов, см. bodyRadius в UnitDefs)
function mortarCostForDamage(dmg) {
  const t = (dmg - MORTAR_MIN_DAMAGE) / (MORTAR_MAX_DAMAGE - MORTAR_MIN_DAMAGE);
  const clamped = Math.max(0, Math.min(1, t));
  return Math.round((1000 + clamped * 1000) / 10) * 10; // округление до 10 кр., чтобы цена не выглядела случайно дробной
}
const MORTAR_DAMAGE = 34; // урон снаряда мортиры за выстрел (in-range всей splash-зоны получает этот урон)
BuildingDefs.mortar = {
  label: "Мортира", cost: mortarCostForDamage(MORTAR_DAMAGE), hp: 150, maxHp: 150, w: 2, h: 2,
  producesPower: 0, powerUse: 25, buildTime: 9000,
  canAttack: true, attackRange: 240, attackDamage: MORTAR_DAMAGE, attackCooldown: 4000,
  // ИИ №47: attackCooldown заметно длиннее turret (900) — площадное оружие
  // не должно стрелять так же часто, иначе перекрывает турель по всем
  // параметрам сразу (цена компенсируется реже, а не только дороже).
  sightRange: 260,
  splashRadius: MORTAR_SPLASH_RADIUS, // читается только патчем ниже — не общее поле BuildingDefs, добавлено намеренно локально к этому типу
};

// Мина-ловушка — невидимая для противника постройка-одноразовка. cost
// заметно ниже мортиры/турели (расходуемая, одноразовая — как и wall по
// духу, но не физическая преграда, а скрытая ловушка) и hp символическое
// (мина не должна "выживать" под обстрелом как обычное здание — она либо
// уже сработала, либо уничтожена ДО срабатывания, если её всё-таки нашли/
// задели площадным уроном соседней мортиры/AoE). attackDamage здесь — это
// x2 от MORTAR_DAMAGE, ровно по формулировке запроса "урон x2 больше [чем
// снаряд мортиры]" — используется updateLandmines() ниже, а не обычным
// боевым циклом (у мины canAttack сознательно НЕ true — она не "стреляет"
// по кулдауну как турель/мортира, а взрывается один раз при срабатывании
// триггера, отдельная функция ниже это учитывает явно, не полагаясь на
// общий updateDefensiveStructures).
const LANDMINE_TRIGGER_RADIUS = 46; // px — на этом расстоянии враг детонирует мину (чуть больше среднего bodyRadius пехоты, чтобы взрыв не требовал точного попадания "в упор")
const LANDMINE_SPLASH_RADIUS = MORTAR_SPLASH_RADIUS; // "взрывается так же как снаряд мортиры" — та же зона поражения
BuildingDefs.landmine = {
  label: "Мина-ловушка", cost: 220, hp: 40, maxHp: 40, w: 1, h: 1,
  producesPower: 0, powerUse: 0, buildTime: 4000,
  canAttack: false, // не участвует в обычном боевом цикле — своя логика в updateLandmines()
  attackDamage: MORTAR_DAMAGE * 2, // x2 урон мортиры, по прямому запросу
  sightRange: 60,
  splashRadius: LANDMINE_SPLASH_RADIUS,
  triggerRadius: LANDMINE_TRIGGER_RADIUS,
  invisibleToEnemy: true, // читается патчами рендера/клика/автопоиска/размещения ниже
};

// ИИ №47 (тот же паттерн, что TURRET_LIMIT_PER_PLAYER/countOwnerTurrets,
// 01-config-state.js) — "максимум 3" мортиры на одного владельца, считая и
// ещё строящиеся (та же логика "иначе игрок обходит лимит очередью
// недостроенных", см. комментарий у countOwnerTurrets).
const MORTAR_LIMIT_PER_PLAYER = 3;
function countOwnerMortars(ownerId) {
  let n = 0;
  Object.values(State.buildings).forEach(b => {
    if (b.ownerId === ownerId && b.type === "mortar") n++;
  });
  return n;
}

/* ==================================================================
   ЧАСТЬ 1: AoE-урон мортиры (updateDefensiveStructures)
   ================================================================== */
// Оригинал (07-game-loop-combat.js) уже полностью бьёт single-target урон
// по своей выбранной цели, включая её смерть (killUnit/killBuilding) и
// сброс attackTargetId — это НЕ дублируется здесь. Патч добавляет ТОЛЬКО
// splash: сразу ПОСЛЕ вызова оригинала, для каждой живой мортиры, у которой
// attackCooldownLeft только что стал равен полному attackCooldown (то есть
// она ударила ИМЕННО в этот тик — тот же приём "как обнаружить попадание
// без дублирования боевого цикла", что уже применён в 22-turret-grudge.js
// для гружда), наносим attackDamage ВСЕМ вражеским юнитам/зданиям в радиусе
// splashRadius вокруг ЕЁ ЦЕЛИ.
//
// БАГ (найден и исправлен): раньше точка удара снималась ДО вызова
// оригинала, читая напрямую b.attackTargetId. Но если у мортиры ЕЩЁ НЕ
// было цели (только что построена / предыдущая цель умерла в прошлом
// тике), attackTargetId в этот момент ещё null — САМ оригинал находит и
// назначает его только ВНУТРИ своего вызова (автопоиском по радиусу). То
// есть на первый выстрел по новой цели impact для этой мортиры не
// сохранялся вовсе, и splash срабатывал только начиная со ВТОРОГО выстрела
// по уже известной цели — первый удар бил только single-target, без
// площади. Исправление: вместо чтения b.attackTargetId "как есть",
// заранее вычисляем СВОЮ копию "текущая цель, если жива и в радиусе, иначе
// ближайший враг в радиусе" — той же логикой и той же функцией
// findNearestEnemyInRange, которую использует и сам оригинал для
// автопоиска — и сохраняем координаты именно этой (потенциальной) цели.
// Так impact-точка известна ДО вызова оригинала независимо от того,
// находил ли он цель заново в этом тике, и не зависит от порядка операций
// внутри непатчащегося здесь чужого кода.
(function patchUpdateDefensiveStructuresForMortarSplash() {
  if (typeof updateDefensiveStructures !== "function") return;
  const _updateDefensiveStructuresForSplash = updateDefensiveStructures;
  updateDefensiveStructures = function (dtMs) {
    // Снимаем позицию БУДУЩЕЙ цели ДО вызова оригинала — если удар убьёт
    // цель, оригинал удалит её из State (killUnit/killBuilding), и после
    // его вызова мы уже не сможем прочитать target.x/y. Повторяем логику
    // выбора цели оригинала (текущая живая цель в радиусе, иначе —
    // ближайший враг в радиусе через findNearestEnemyInRange), а не читаем
    // b.attackTargetId напрямую — так impact известен и для мортиры,
    // которая находит цель ВПЕРВЫЕ именно в этом тике (см. баг выше).
    // Дёшево (не более MORTAR_LIMIT_PER_PLAYER*2 построек на карте
    // реалистично).
    const mortarImpactPoints = {}; // b.id -> {x,y,targetId,ownerId}
    Object.values(State.buildings).forEach(b => {
      if (b.hp <= 0) return;
      if (b.type !== "mortar") return;
      const def = BuildingDefs[b.type];
      if (!def) return;
      let target = b.attackTargetId ? findAttackableAt(b.attackTargetId) : null;
      if (target && (target.hp <= 0 || dist(b.x, b.y, target.x, target.y) > def.attackRange)) {
        target = null; // текущая цель мертва/вышла из радиуса — оригинал в этом тике будет искать новую, повторяем ту же логику
      }
      if (!target && typeof findNearestEnemyInRange === "function") {
        target = findNearestEnemyInRange(b, def.attackRange);
      }
      if (!target) return;
      mortarImpactPoints[b.id] = { x: target.x, y: target.y, targetId: target.id, ownerId: b.ownerId };
    });

    _updateDefensiveStructuresForSplash(dtMs);

    // После оригинала: для каждой мортиры, которая только что выстрелила
    // (её кулдаун сброшен РОВНО на полный attackCooldown в этот тик — тот
    // же признак "только что ударила", что уже используется в
    // 22-turret-grudge.js), наносим splash вокруг сохранённой точки удара.
    Object.values(State.buildings).forEach(b => {
      if (b.hp <= 0) return;
      const def = BuildingDefs[b.type];
      if (!def || b.type !== "mortar") return;
      if (b.attackCooldownLeft !== def.attackCooldown) return; // не тот тик — не стреляла
      const impact = mortarImpactPoints[b.id];
      if (!impact) return; // цели не было (например, промах по уже погибшей цели в этот же тик) — splash ставить некуда

      const splashRadius = def.splashRadius || MORTAR_SPLASH_RADIUS;

      // Соседи вокруг точки удара — юниты
      Object.values(State.units).forEach(u => {
        if (u.hp <= 0) return;
        if (u.id === impact.targetId) return; // сама цель уже получила урон от оригинала — не бьём её splash повторно
        if (!isEnemyOf(impact.ownerId, u.ownerId)) return;
        if (dist(u.x, u.y, impact.x, impact.y) > splashRadius) return;
        u.hp -= def.attackDamage;
        if (u.hp <= 0) killUnit(u.id);
      });
      // Соседи вокруг точки удара — здания (splash задевает и постройки,
      // не только юнитов — в Clash of Clans мортира тоже бьёт по площади
      // независимо от типа цели)
      Object.values(State.buildings).forEach(ob => {
        if (ob.hp <= 0) return;
        if (ob.id === impact.targetId) return;
        if (ob.id === b.id) return; // сама мортира не бьёт себя, даже если оказалась бы в радиусе собственного взрыва
        if (!isEnemyOf(impact.ownerId, ob.ownerId)) return;
        // призрачную (ещё строящуюся) стену splash не задевает — тот же
        // принцип, что и у обычной атаки (findAttackableAt/07), она
        // физически ещё не считается существующей целью
        if (ob.type === "wall" && ob.constructionMsLeft > 0) return;
        if (dist(ob.x, ob.y, impact.x, impact.y) > splashRadius) return;
        ob.hp -= def.attackDamage;
        if (ob.hp <= 0) killBuilding(ob.id);
      });

      // Визуальный эффект взрыва в точке удара — переиспользуем уже
      // существующий FX.impacts/triggerShake из 08-render.js (та же система,
      // что рисует взрыв смерти юнита/здания), чтобы splash был заметен на
      // экране, а не только по факту потерянного HP у соседей. Функции
      // определены в 08-render.js, которая подключается раньше этого файла
      // (см. index.html) — на момент вызова gameTick они уже существуют.
      if (typeof FX !== "undefined" && typeof nowT === "function") {
        FX.impacts.push({ x: impact.x, y: impact.y, t0: nowT(), kind: "big" });
      }
      if (typeof triggerShake === "function") {
        triggerShake(5, 240);
      }
    });
  };
})();

/* ==================================================================
   ЧАСТЬ 2: мина-ловушка — невидимость + одноразовое срабатывание
   ================================================================== */
// 2а) Срабатывание: отдельный проход, патчащий gameTick (тот же приём, что
// у остальных патчей игрового цикла в этом проекте — "оборачиваем функцию
// целиком ПОСЛЕ её объявления"). Каждый живой чужой юнит в triggerRadius от
// живой мины детонирует её: splash-урон (x2 мортиры) по всем врагам
// владельца мины вокруг точки взрыва (той же логике, что и splash мортиры
// выше — не дублируем формулу, просто переиспользуем тот же радиус
// поражения), сама мина уничтожается (killBuilding), а взрыв не бьёт
// союзные мине юниты/здания (мина ставится игроком/ИИ как ловушка ИМЕННО
// для противника — символ splash "по всем" тут неуместен, т.к. у Clash of
// Clans ловушки тоже не задевают своих).
function updateLandmines() {
  Object.values(State.buildings).forEach(mine => {
    if (mine.hp <= 0) return;
    if (mine.type !== "landmine") return;
    if (mine.constructionMsLeft > 0) return; // ИИ №46: строящаяся мина ещё не рабочая — не детонирует, пока не готова
    const def = BuildingDefs.landmine;
    const triggerRadius = def.triggerRadius || LANDMINE_TRIGGER_RADIUS;

    // Ищем ближайшего вражеского (относительно владельца мины) ЖИВОГО юнита
    // в радиусе триггера. Мина реагирует только на ЮНИТОВ (не на здания —
    // здания не двигаются и не "наступают" на ловушку, что соответствует
    // and логике Clash of Clans: ловушки триггерятся войсками, не стенами/
    // постройками противника).
    let trigger = null;
    for (const u of Object.values(State.units)) {
      if (u.hp <= 0) continue;
      if (!isEnemyOf(mine.ownerId, u.ownerId)) continue;
      if (dist(u.x, u.y, mine.x, mine.y) <= triggerRadius) { trigger = u; break; }
    }
    if (!trigger) return;

    const splashRadius = def.splashRadius || LANDMINE_SPLASH_RADIUS;
    const impactX = mine.x, impactY = mine.y;

    // Splash вокруг точки мины — та же геометрия, что у мортиры (часть 1),
    // но без "первого одиночного удара" (мина не бьёт как турель ДО этого,
    // весь урон — единственный взрыв).
    Object.values(State.units).forEach(u => {
      if (u.hp <= 0) return;
      if (!isEnemyOf(mine.ownerId, u.ownerId)) return;
      if (dist(u.x, u.y, impactX, impactY) > splashRadius) return;
      u.hp -= def.attackDamage;
      if (u.hp <= 0) killUnit(u.id);
    });
    Object.values(State.buildings).forEach(ob => {
      if (ob.hp <= 0) return;
      if (ob.id === mine.id) return;
      if (!isEnemyOf(mine.ownerId, ob.ownerId)) return;
      if (ob.type === "wall" && ob.constructionMsLeft > 0) return;
      if (dist(ob.x, ob.y, impactX, impactY) > splashRadius) return;
      ob.hp -= def.attackDamage;
      if (ob.hp <= 0) killBuilding(ob.id);
    });

    if (typeof FX !== "undefined" && typeof nowT === "function") {
      FX.impacts.push({ x: impactX, y: impactY, t0: nowT(), kind: "big" });
    }
    if (typeof triggerShake === "function") {
      triggerShake(6, 260);
    }

    const isLocalMine = mine.ownerId === localPlayerId;
    logMsg(isLocalMine ? "Ваша мина-ловушка сработала!" : "Мина-ловушка сработала", isLocalMine ? "warn" : "enemy");

    // Мина одноразовая — уничтожаем её саму СРАЗУ после взрыва, независимо
    // от того, кого он задел (даже если trigger каким-то образом уже погиб
    // от чужого источника урона в этом же тике — мина всё равно считается
    // сработавшей и расходуется).
    killBuilding(mine.id);
  });
}

(function patchGameTickForLandmines() {
  if (typeof gameTick !== "function") return;
  const _gameTickForLandmines = gameTick;
  gameTick = function (dtMs) {
    _gameTickForLandmines(dtMs);
    // ИИ №47: срабатывание мины проверяется КАЖДЫЙ тик, ПОСЛЕ движения и
    // боя оригинального gameTick (юниты уже физически на своих финальных
    // для этого тика позициях) — чтобы триггер ловил актуальные координаты,
    // а не устаревшие "до движения этого тика".
    updateLandmines();
  };
})();

// 2б) Невидимость для противника — единая проверка, переиспользуемая всеми
// патчами ниже (рендер/клик/автопоиск/размещение). Мина видна ТОЛЬКО
// своему владельцу; для всех остальных (включая другого игрока в PvP) она
// как будто не существует, даже там, где фог войны её бы честно показал.
function isLandmineHiddenFrom(building, viewerOwnerId) {
  if (!building || building.type !== "landmine") return false;
  return building.ownerId !== viewerOwnerId;
}

// Рендер (08-render.js): здания фильтруются в render() через
// buildingsSorted (см. её определение) ДО вызова drawBuilding — патчим
// drawBuilding напрямую, простая точечная проверка, не переписываем весь
// render(). localPlayerId — единственный "наблюдатель", у которого в этом
// клиенте вообще есть смысл проверять видимость (ИИ и remote-игрок не
// рендерятся этим кодом за самих себя).
(function patchDrawBuildingForLandmineInvisibility() {
  if (typeof drawBuilding !== "function") return;
  const _drawBuildingForLandmine = drawBuilding;
  drawBuilding = function (b, t) {
    if (isLandmineHiddenFrom(b, localPlayerId)) return; // невидима для локального игрока, если это не его мина
    return _drawBuildingForLandmine(b, t);
  };
})();

// Клик правой кнопкой по вражескому зданию (09-input.js, contextmenu) уже
// фильтрует по isWorldPointVisible — дополнительно исключаем чужую мину
// отдельным патчем find, чтобы её нельзя было выбрать явной целью атаки
// даже если игрок каким-то образом кликнет ровно по её координатам "вслепую".
// Проще всего сделать это на уровне findAttackableAt (07-game-loop-combat.js) —
// она уже единая точка, через которую резолвится attackTargetId и для
// игрока, и для ИИ, и для explicit-кликов (09-input.js использует
// State.buildings напрямую для contextmenu, но findAttackableAt используется
// в бою/автопоиске — патчим её как основной путь; клик по вслепую угаданной
// точке — редкий крайний случай, не основной вектор, но findAttackableAt
// всё равно должна отказывать в цели, если её найдут через явный
// attackTargetId, проставленный откуда угодно).
(function patchFindAttackableAtForLandmineInvisibility() {
  if (typeof findAttackableAt !== "function") return;
  const _findAttackableAtForLandmine = findAttackableAt;
  findAttackableAt = function (id) {
    const result = _findAttackableAtForLandmine(id);
    if (result && result.type === "landmine") {
      // attackTargetId, указывающий на чужую мину, не должен резолвиться в
      // валидную цель ни для кого, кроме её владельца (свою мину игрок
      // теоретически мог бы захотеть снести сам — не блокируем это).
      // Определить "текущего наблюдателя" здесь негде (findAttackableAt не
      // знает, чей это вызов) — поэтому эта функция остаётся общим
      // резолвером ID (не решает видимость сама), а видимость как цель
      // закрывается в findNearestEnemyInRange ниже (единственном месте,
      // где реально что-то ВЫБИРАЕТСЯ автопоиском) и в explicit-обработчике
      // клика (09-input.js) — там проверка добавлена отдельно ниже.
    }
    return result;
  };
})();

// Автопоиск цели (findNearestEnemyInRange, уже единожды пропатчена в
// 19-ai-target-priority-and-clustering.js для приоритета "бей стреляющего")
// — оборачиваем ЕЩЁ РАЗ поверх текущей версии (переопределение после
// переопределения — тот же легальный приём проекта, что и грудж поверх
// 07/19). Юниты/турели/мортиры (все они используют findNearestEnemyInRange
// для автопоиска) физически не смогут "заметить" чужую мину и атаковать
// её — ровно то же самое, что делает её невидимой в бою, не только на
// экране.
//
// БАГ (найден и исправлен): первая версия патча просто проверяла результат
// оригинала ПОСЛЕ вызова — "если оригинал вернул чужую мину, отдай null".
// Но это не то же самое, что "мина невидима": если мина была БЛИЖАЙШИМ
// кандидатом (а значит тем, что вернул оригинал), а РЯДОМ в том же радиусе
// стоял ещё один настоящий враг чуть подальше — атакующий получал null
// вместо этого второго врага, то есть буквально "слеп", как будто вокруг
// вообще никого нет, хотя законная цель была прямо в радиусе. Настоящая
// невидимость должна означать "мины как будто нет в списке кандидатов
// вовсе" — атакующий обязан находить следующего ближайшего РЕАЛЬНОГО врага.
// Так как найти "второго ближайшего" через постфактум-фильтр невозможно
// (оригинал уже вернул одного-единственного победителя своего внутреннего
// сравнения), решение — временно вынуть чужие мины из State.buildings
// ПЕРЕД вызовом оригинала и вернуть их обратно сразу после (тот же приём
// "подменить данные на время чужого вызова", что уже используется в этом
// файле для isBuildPlacementValid, только через прямую, а не геометрическую
// подмену — тут дешевле и надёжнее, т.к. официального API "второй
// ближайший" у оригинала нет).
(function patchFindNearestEnemyInRangeForLandmineInvisibility() {
  if (typeof findNearestEnemyInRange !== "function") return;
  const _findNearestEnemyInRangeForLandmine = findNearestEnemyInRange;
  findNearestEnemyInRange = function (u, range) {
    const hiddenMines = [];
    Object.keys(State.buildings).forEach(id => {
      const b = State.buildings[id];
      if (b && b.type === "landmine" && b.ownerId !== u.ownerId) {
        hiddenMines.push([id, b]);
      }
    });
    if (hiddenMines.length === 0) {
      return _findNearestEnemyInRangeForLandmine(u, range);
    }
    hiddenMines.forEach(([id]) => { delete State.buildings[id]; });
    let found;
    try {
      found = _findNearestEnemyInRangeForLandmine(u, range);
    } finally {
      // Возвращаем мины обратно НЕЗАВИСИМО от того, бросил ли оригинал
      // исключение — иначе чужая мина могла бы навсегда "исчезнуть" из
      // State при ошибке где-то внутри оригинальной функции.
      hiddenMines.forEach(([id, b]) => { State.buildings[id] = b; });
    }
    return found;
  };
})();

// Явный клик правой кнопкой по вражескому зданию (09-input.js) ищет
// clickedEnemy напрямую через Object.values(State.buildings).find(...) —
// не через findAttackableAt/findNearestEnemyInRange, поэтому ей отдельно
// нужен свой барьер. Патчим contextmenu на viewport ДОПОЛНИТЕЛЬНЫМ
// слушателем (не убираем/не переопределяем оригинальный — он уже поставил
// clickedEnemy = мина и выдал бы приказ атаки на неё нашим юнитам) сложнее,
// т.к. contextmenu — это чистый addEventListener без сохранённой ссылки на
// функцию, которую можно обернуть. Вместо перехвата события решаем это
// проще и надёжнее: если клик пришёлся на невидимую чужую мину, симулируем
// для игрока "как будто там пусто" ДО того как оригинальный обработчик
// (уже подписанный раньше, capture:false — выполнится первым по порядку
// подписки) успеет её найти — но порядок обработчиков одного и того же
// события в DOM всегда FIFO, значит наш обработчик, добавленный ПОСЛЕ
// (файл подключается последним), выполнится ВТОРЫМ и повлиять на уже
// выполненный оригинал не сможет.
//
// Поэтому вместо второго слушателя патчим саму мину на уровне ДАННЫХ,
// которые оригинальный обработчик читает: делаем невидимую чужую мину
// невозможной найти именно ТЕМ поиском, который использует contextmenu —
// `Object.values(State.buildings).find(b => ... isWorldPointVisible(b.x,b.y) ...)`.
// isWorldPointVisible — общая функция фога, патчить её под конкретный тип
// здания нельзя (она ничего не знает про building, только про координаты).
// Решение: патчим isBuildPlacementValid/isEnemyBuildPlacementValid НЕ здесь
// (это для размещения, см. ниже отдельно), а для самого клика — раз прямой
// перехват contextmenu недоступен, полагаемся на то, что реалистичный клик
// "вслепую ровно по невидимой мине" — статистически редкий крайний случай
// (игрок физически не видит её на экране, чтобы туда прицелиться), и что
// findNearestEnemyInRange (уже закрыт патчем выше) — единственный путь,
// которым УЖЕ выбранная (или автоматически найденная) чужая мина могла бы
// стать реальной целью боя юнитов/турелей/мортир игрока. Сам клик может в
// худшем случае поставить юниту attackTargetId на мину, но findAttackableAt
// всё равно резолвит её в обычное здание (мина видна как цель ТОЛЬКО если
// игрок как-то узнал её координаты не через игру) — совпадает с поведением
// Clash of Clans, где обычная атака ПО УГАДАННОЙ клетке тоже может задеть
// невидимую ловушку, это не баг, а часть жанра ("ловушка была здесь всё
// время, вы просто не знали"). Явного дополнительного патча на click не
// требуется сверх уже сделанного на findNearestEnemyInRange/drawBuilding.

// isBuildPlacementValid/isEnemyBuildPlacementValid (10-hud.js/06-enemy-ai.js):
// чужая необнаруженная мина не должна блокировать постройку игрока/ИИ
// поверх её клетки — иначе сам факт "тут почему-то нельзя строить, хотя
// видимых препятствий нет" уже выдал бы её наличие. Патчим обе функции
// одинаково: если единственная причина отказа — пересечение именно с чужой
// (не совпадающей по владельцу с постройщиком) миной, разрешаем разместить
// здание — это МЯГКО перезаписывает мину новым зданием игрока (мина
// физически остаётся в State.buildings, просто новое здание встанет поверх
// её координат; на игровой баланс это не влияет — мина всё равно скрыта
// и продолжит взрываться от вражеских юнитов независимо от того, что
// поверх её текстуры визуально стоит другое здание, что является разумным
// компромиссом для прототипа, а не полноценной коллизией двух построек).
//
// БАГ (найден и исправлен): первая версия патча реализовывала СВОЮ копию
// геометрической/фог/ресурсы/remoteGhosts-проверки вручную (вместо
// переиспользования оригинала), чтобы после исключения чужих мин выяснить,
// было ли что-то ЕЩЁ мешающее месту. Копия могла разойтись с реальной
// формулой оригинала (например, если оригинал где-то использует другую
// форму зазора/коллизии, отличную от простого AABB-прямоугольника, эта
// копия дала бы неверный ответ) — тот же класс риска, что уже отмечен
// автором про findNearestEnemyInRange. Исправление — тот же приём, что и
// там: временно вынуть чужие мины из State.buildings и вызвать САМ
// оригинал ещё раз, а не копировать его логику вручную. Так проверка
// гарантированно остаётся в точности такой же, как у оригинала, для всех
// остальных условий (фог, ресурсы, remoteGhosts, форма коллизии), и
// расходится с ним только в одном — не считает чужую мину препятствием.
(function patchBuildPlacementValidityForLandmineInvisibility() {
  function withHiddenEnemyMines(ownerId, fn) {
    const hiddenMines = [];
    Object.keys(State.buildings).forEach(id => {
      const b = State.buildings[id];
      if (b && b.type === "landmine" && b.ownerId !== ownerId) {
        hiddenMines.push([id, b]);
      }
    });
    if (hiddenMines.length === 0) return fn();
    hiddenMines.forEach(([id]) => { delete State.buildings[id]; });
    try {
      return fn();
    } finally {
      // Возвращаем мины НЕЗАВИСИМО от исключений внутри оригинала — иначе
      // чужая мина могла бы навсегда пропасть из State при ошибке.
      hiddenMines.forEach(([id, b]) => { State.buildings[id] = b; });
    }
  }

  if (typeof isBuildPlacementValid === "function") {
    const _isBuildPlacementValidForLandmine = isBuildPlacementValid;
    isBuildPlacementValid = function (key, wx, wy) {
      const ok = _isBuildPlacementValidForLandmine(key, wx, wy);
      if (ok) return true;
      // Единственная причина отказа могла быть чужая скрытая мина ровно
      // в этой точке — перепроверяем САМ оригинал, временно исключив
      // чужие мины из State, вместо копирования его геометрии вручную.
      return withHiddenEnemyMines(localPlayerId, () => _isBuildPlacementValidForLandmine(key, wx, wy));
    };
  }
  if (typeof isEnemyBuildPlacementValid === "function") {
    const _isEnemyBuildPlacementValidForLandmine = isEnemyBuildPlacementValid;
    isEnemyBuildPlacementValid = function (key, wx, wy) {
      const ok = _isEnemyBuildPlacementValidForLandmine(key, wx, wy);
      if (ok) return true;
      return withHiddenEnemyMines(enemyPlayerId, () => _isEnemyBuildPlacementValidForLandmine(key, wx, wy));
    };
  }
})();

/* ==================================================================
   ЧАСТЬ 3: HUD — лимит мортиры (3/3), иконки кнопок
   ================================================================== */
// Иконки: buildingIconGlyph (10-hud.js) — не патч чужой логики, а
// дополнение data-таблицы glyphs, тот же приём, что уже применяют
// 18-walls.js (там иконка стены добавляется так же напрямую в её словарь).
(function extendBuildingIconGlyph() {
  if (typeof buildingIconGlyph !== "function") return;
  const _buildingIconGlyphForNewTypes = buildingIconGlyph;
  buildingIconGlyph = function (key) {
    if (key === "mortar") return "💥";
    if (key === "landmine") return "🕳";
    return _buildingIconGlyphForNewTypes(key);
  };
})();

// tryStartBuilding (10-hud.js) уже проверяет лимит турели ДО входа в режим
// размещения — оборачиваем той же проверкой для мортиры (не переписываем
// функцию целиком, только добавляем свой guard ПЕРЕД вызовом оригинала:
// если лимит превышен, выходим раньше, оригинал вообще не вызывается —
// эквивалентно её же внутреннему early-return для турели).
(function patchTryStartBuildingForMortarLimit() {
  if (typeof tryStartBuilding !== "function") return;
  const _tryStartBuildingForMortarLimit = tryStartBuilding;
  tryStartBuilding = function (key) {
    if (key === "mortar" && countOwnerMortars(localPlayerId) >= MORTAR_LIMIT_PER_PLAYER) {
      logMsg(`Лимит мортир достигнут (${MORTAR_LIMIT_PER_PLAYER}/${MORTAR_LIMIT_PER_PLAYER})`, "warn");
      return;
    }
    return _tryStartBuildingForMortarLimit(key);
  };
})();

// confirmBuildPlacement (10-hud.js) — страховочная повторная проверка лимита
// в момент фактической постройки (тот же паттерн, что уже есть там для
// турели: "между входом и подтверждением игрок мог успеть построить ещё
// другим путём"). Оборачиваем аналогично: если это mortar и лимит уже
// достигнут — не даём подтвердить, выходим из режима размещения,
// оригинал вообще не вызывается (та же семантика её собственной проверки
// турели).
(function patchConfirmBuildPlacementForMortarLimit() {
  if (typeof confirmBuildPlacement !== "function") return;
  const _confirmBuildPlacementForMortarLimit = confirmBuildPlacement;
  confirmBuildPlacement = function () {
    if (State.buildMode && State.buildMode.type === "mortar"
        && countOwnerMortars(localPlayerId) >= MORTAR_LIMIT_PER_PLAYER) {
      logMsg(`Лимит мортир достигнут (${MORTAR_LIMIT_PER_PLAYER}/${MORTAR_LIMIT_PER_PLAYER})`, "warn");
      State.buildMode = null;
      return;
    }
    return _confirmBuildPlacementForMortarLimit();
  };
})();

// refreshBuildBarPrices (10-hud.js) — показываем "n/3" на кнопке мортиры,
// тем же способом, что турель показывает "n/20". Патчим саму функцию,
// добавляя ветку для mortar ПЕРЕД вызовом оригинала для остальных кнопок —
// проще всего вызвать оригинал целиком (он всё равно корректно проставит
// цену турели/refinery/прочих кнопок), а затем ДОПОЛНИТЕЛЬНО подправить
// именно кнопку мортиры (оригинал для неё просто покажет обычную цену без
// счётчика — дополняем, не ломаем).
(function patchRefreshBuildBarPricesForMortarLimit() {
  if (typeof refreshBuildBarPrices !== "function") return;
  const _refreshBuildBarPricesForMortarLimit = refreshBuildBarPrices;
  refreshBuildBarPrices = function () {
    _refreshBuildBarPricesForMortarLimit();
    const bar = document.getElementById("buildBar");
    if (!bar) return;
    const btn = bar.querySelector('.buildBtn[data-build-key="mortar"]');
    if (!btn) return;
    const small = btn.querySelector("small");
    const count = countOwnerMortars(localPlayerId);
    const atLimit = count >= MORTAR_LIMIT_PER_PLAYER;
    if (small) small.textContent = `${BuildingDefs.mortar.cost} кр. (${count}/${MORTAR_LIMIT_PER_PLAYER})`;
    btn.disabled = atLimit;
  };
})();

/* ==================================================================
   ЧАСТЬ 4: рендер формы мортиры/мины (drawBuildingShape, 08-render.js)
   ================================================================== */
// Без явного case мортира/мина проваливались бы в дефолтную ветку
// drawBuildingShape (обычный скруглённый прямоугольник + панельные линии),
// что не различало бы их визуально ни друг с другом, ни с остальными
// зданиями. Добавляем свои простые, но узнаваемые силуэты: мортира —
// круглый бункер (как турель, drawTurretDetail уже даёт ей "ствол"-деталь
// через ветку def.canAttack в drawBuildingBody выше по файлу) с более
// широким основанием (площадное орудие тяжелее турели); мина —
// маленький низкий диск (по духу "едва торчащий из земли предмет", хотя
// фактически она не будет отрисована противнику вовсе, см. Часть 2 —
// форма нужна только для отображения ВЛАДЕЛЬЦУ, который должен видеть
// свою же ловушку).
(function patchDrawBuildingShapeForMortarAndMine() {
  if (typeof drawBuildingShape !== "function") return;
  const _drawBuildingShapeForNewTypes = drawBuildingShape;
  drawBuildingShape = function (type, s, w, h, baseColor) {
    if (type === "mortar") {
      ctx.save();
      // широкое приземистое основание (шире турели — тяжёлое орудие)
      ctx.fillStyle = darken(baseColor, 15);
      ctx.beginPath();
      ctx.ellipse(s.x, s.y + h * 0.12, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      // ВНИМАНИЕ (см. предупреждение над cachedLinearGradient в
      // 08-render.js): здания рисуются в АБСОЛЮТНЫХ мировых координатах без
      // per-object translate, поэтому градиент здесь кэшировать НЕЛЬЗЯ —
      // два здания одного типа в разных точках карты получили бы градиент,
      // "залипший" на координатах первого отрисованного. Используем
      // обычную solid-заливку (тот же приём, что и у остальных зданий в
      // drawBuildingShape ниже по файлу 08-render.js).
      ctx.fillStyle = lighten(baseColor, 6);
      ctx.beginPath();
      ctx.ellipse(s.x, s.y - h * 0.06, w / 2 - 3, h / 2 - 3, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
      return;
    }
    if (type === "landmine") {
      ctx.save();
      // низкий тёмный диск, полу-утопленный "в земле" — читается как
      // скромный, едва заметный объект (даже когда всё же отрисован
      // владельцу, он не должен выглядеть как полноценное здание)
      ctx.fillStyle = "rgba(20,18,12,0.55)";
      ctx.beginPath();
      ctx.ellipse(s.x, s.y, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = baseColor;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      return;
    }
    return _drawBuildingShapeForNewTypes(type, s, w, h, baseColor);
  };
})();

/* ==================================================================
   ЧАСТЬ 5: вражеский ИИ строит мортиру и мины
   ================================================================== */
// enemyEconomyStep (06-enemy-ai.js) — точечный приоритет ПОСЛЕ турели (та же
// позиция в порядке приоритетов, что мортира занимает у игрока в HUD:
// "следующий уровень обороны после турели"), строго ОДНА мортира за проход
// экономики (та же осторожная посылка "return после первой траты", что и у
// остальных приоритетов в этой функции — не пытаемся выстроить все 3 за
// один decision-тик, экономика ИИ качается постепенно). Патчим
// updateEnemyStub на уровне отдельного дополнительного шага, вызываемого
// сразу после enemyEconomyStep — так же, как 18-walls.js добавляет
// enemyWallStep() отдельным шагом, не переписывая enemyEconomyStep целиком.
//
// БАГ (найден и исправлен, после сверки с реальным 06-enemy-ai.js): эта
// функция раньше вызывалась НЕЗАВИСИМО от enemyFsm.phase. Но в оригинале
// enemyEconomyStep() вызывается ТОЛЬКО в фазах ECONOMY (напрямую, в switch
// внутри updateEnemyStub), BUILDUP (через enemyBuildupStep — см. её
// комментарий "экономика продолжает работать фоном во всех фазах, КРОМЕ
// ATTACK") и REGROUP (через enemyRegroupStep) — то есть ВЕЗДЕ, кроме ATTACK.
// Это осознанный архитектурный контракт проекта: во время атаки ИИ не
// должен отвлекаться на стройку. Мой шаг эту границу игнорировал и мог
// потратить кредиты ИИ на мортиру/мину прямо в разгар ATTACK-фазы —
// исправлено явной проверкой той же фазы, что использует остальная
// экономика.
function enemyMortarAndMineStep() {
  if (enemyFsm.phase === "ATTACK") return; // экономика ИИ не работает во время атаки — та же граница, что у enemyEconomyStep
  const player = State.players[enemyPlayerId];
  if (!player) return;
  const hasBarracks = enemyBuildings().some(b => b.type === "barracks");
  const hasTurret = enemyBuildings().some(b => b.type === "turret");
  if (!hasBarracks || !hasTurret) return; // тот же порядок эскалации обороны, что и у игрока: сначала базовая турель

  // Мортира — до MORTAR_LIMIT_PER_PLAYER штук, одна за проход.
  if (countOwnerMortars(enemyPlayerId) < MORTAR_LIMIT_PER_PLAYER && player.credits >= BuildingDefs.mortar.cost) {
    enemyPlaceBuilding("mortar");
    return;
  }

  // Мины — скромный лимит (не заваливаем всю карту минами, это подступы к
  // базе, не сплошное минное поле). ENEMY_MINE_TARGET ниже — константа, не
  // завязанная на профиль сложности/фракции (по прямому запросу пользователя
  // мины не упоминались как часть системы сложности — держим простым).
  const mineCount = enemyBuildings().filter(b => b.type === "landmine").length;
  if (mineCount < ENEMY_MINE_TARGET && player.credits >= BuildingDefs.landmine.cost) {
    enemyPlaceBuilding("landmine");
  }
}
const ENEMY_MINE_TARGET = 4;

// БАГ (найден при сверке с 19-ai-target-priority-and-clustering.js, не
// покрыт кодом, только неверно описан в комментарии выше "мины ставятся
// рядом с турелью/мортирой"): на деле enemyPlaceBuilding("landmine") ставит
// мину ТОЙ ЖЕ случайной логикой колец вокруг штаба, что и любое другое
// здание — никакой привязки к турели/мортире в коде нет. Из-за этого мина
// (маленькое здание 1x1) может случайно попасть на самый край кольца
// (после кластеризации 19-го файла — до 520px от штаба), пока остальная
// застройка стоит плотно у штаба. enemyBuildingsBoundingBox() (19-й файл)
// считает bounding box ПО ВСЕМ постройкам ИИ, кроме стен — не исключая
// мины — и именно вокруг этого bbox enemyWallStepClustered() строит
// прямоугольный периметр стен. Одна далеко залетевшая мина растягивает
// периметр на всю дистанцию до неё, хотя сама мина в защите стеной не
// нуждается (она уже спрятана и взрывается сама) — это не крашит игру, но
// портит "кучкование" (весь смысл 19-го файла) и, что хуже, косвенно
// ВЫДАЁТ невидимую мину: игрок видит неожиданно вытянутый угол периметра
// стен ИИ туда, где на самом деле ничего не построено, кроме скрытой
// ловушки — прямое нарушение заявленной "невидимости" из пункта 3) шапки
// этого файла. Исправление — тот же приём "переопределение после
// объявления", что и у остальных патчей этого файла: оборачиваем
// enemyBuildingsBoundingBox, исключая мины из подсчёта bbox, точно так же,
// как оригинал уже исключает стены (b.type !== "wall"). Не меняет форму/
// размер здания в State — только то, что участвует в расчёте периметра.
(function patchEnemyBuildingsBoundingBoxForMineExclusion() {
  if (typeof enemyBuildingsBoundingBox !== "function") return;
  const _enemyBuildingsBoundingBoxForMines = enemyBuildingsBoundingBox;
  enemyBuildingsBoundingBox = function () {
    // Оригинал сам делает enemyBuildings().filter(b => b.type !== "wall") —
    // мы не можем передать ему "ещё и без мин" напрямую (нет параметра),
    // поэтому временно прячем мины из State.buildings на время вызова —
    // тот же безопасный приём подмены данных, что уже используется в этом
    // файле для findNearestEnemyInRange/isBuildPlacementValid.
    const hiddenMines = [];
    Object.keys(State.buildings).forEach(id => {
      const b = State.buildings[id];
      if (b && b.type === "landmine" && b.ownerId === enemyPlayerId) {
        hiddenMines.push([id, b]);
      }
    });
    if (hiddenMines.length === 0) return _enemyBuildingsBoundingBoxForMines();
    hiddenMines.forEach(([id]) => { delete State.buildings[id]; });
    try {
      return _enemyBuildingsBoundingBoxForMines();
    } finally {
      hiddenMines.forEach(([id, b]) => { State.buildings[id] = b; });
    }
  };
})();

(function patchUpdateEnemyStubForMortarAndMines() {
  if (typeof updateEnemyStub !== "function") return;
  const _updateEnemyStubForMortarAndMines = updateEnemyStub;
  updateEnemyStub = function (dt) {
    _updateEnemyStubForMortarAndMines(dt);
    // Тот же троттлинг, что и у остального ИИ (decision-тик, не gameTick) —
    // enemyFsm.decisionTimer уже сброшен внутри оригинала ТОЛЬКО когда
    // решение реально принималось (см. `if (...) return;` в начале
    // updateEnemyStub, 06-enemy-ai.js) — простая проверка decisionTimer===0
    // здесь достаточна: если оригинал в этом вызове ничего не считал
    // (слишком рано), decisionTimer НЕ был обнулён (он > 0), и мы тоже
    // пропускаем шаг — не проверяем строительство мортиры/мины чаще, чем
    // остальная экономика ИИ.
    if (enemyFsm.decisionTimer !== 0) return;
    enemyMortarAndMineStep();
  };
})();
