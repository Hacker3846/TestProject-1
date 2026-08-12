/* ---------------------------- ИИ №52: приоритет "сначала все опасные точки рядом, штаб — когда угроз не осталось" ---------------------------- */
// Прямой запрос пользователя: "враг должен знать приоритеты хорошо, штаб
// рушить при возможности, но опасные огнестрельные здания и юниты должны
// быть ликвидированы сразу же". Уточнено в диалоге:
//  - приоритет №1 — снести ВСЕ опасные точки (турели/мортиры/стреляющие
//    юниты) в радиусе обнаружения, штаб — только когда угроз рядом не
//    осталось (не "просто первую попавшуюся", не "полпути к штабу мимо
//    турели, которая уже бьёт по нам");
//  - работает СИММЕТРИЧНО — и для вражеского ИИ, и для юнитов игрока.
//
// ДИАГНОЗ (по факту чтения 19-ai-target-priority-and-clustering.js/
// 06-enemy-ai.js/07-game-loop-combat.js):
// Существующий патч (ИИ №35, 19-...js) уже даёт ЛОКАЛЬНЫЙ приоритет "бей
// того, кто СЕЙЧАС атакует именно тебя" внутри findNearestEnemyInRange —
// но это только половина запроса: если рядом стоит турель, которая ЕЩЁ не
// начала стрелять (юнит только приближается, в радиус её attackRange не
// вошёл — а agro-радиус автопоиска шире, ATTACK_MOVE_AGGRO_BONUS), она не
// считается "атакующей" и не получает приоритет — обычный ближайший враг
// мог оказаться менее опасным зданием. Плюс это ЛОКАЛЬНЫЙ выбор ближайшей
// цели на месте — он не решает вопрос "идущая в атаку армия должна вообще
// СВЕРНУТЬ к обнаруженной турели, а не продолжать движение к штабу".
//
// Это два независимых слоя, оба нужны:
//  1) ЛОКАЛЬНЫЙ (автопоиск, findNearestEnemyInRange) — среди целей В
//     РАДИУСЕ range добавляем второй уровень приоритета ПОСЛЕ "кто
//     атакует нас": "кто вообще МОЖЕТ атаковать" (canAttack==true — это
//     турели/мортиры/боевые юниты) ПЕРЕД любым невооружённым зданием
//     (штаб, электростанция, казарма и т.п.). Финальный порядок:
//       1. ближайший атакующий именно нас (уже было, ИИ №35)
//       2. ближайшая опасная цель (canAttack, но пока не бьёт по нам) — НОВОЕ
//       3. ближайшая любая цель (штаб/невооружённое здание) — фолбэк, как раньше
//  2) СТРАТЕГИЧЕСКИЙ (enemyAttackStep, 06-enemy-ai.js) — армия, идущая
//     attack-move к штабу, ДОЛЖНА физически свернуть к обнаруженной
//     опасной цели, если та в радиусе ATTACK_MOVE_AGGRO_BONUS, вместо
//     того чтобы продолжать движение мимо неё к штабу. Это уже частично
//     работает через автопоиск в updateCombat (пункт 1 выше это усиливает),
//     но enemyAttackStep каждый decision-тик ПЕРЕПРИКАЗЫВАЕТ юнита назад к
//     hq, как только он временно освобождается (см. условие
//     arrivedAndIdle) — если юнит только что разобрался с одной турелью,
//     а рядом есть ещё одна, он должен продолжить чистить угрозы, а не
//     сразу получить новый attack-move приказ на hq. Патчим enemyAttackStep:
//     ПЕРЕД тем как переприказать юнита на hq, проверяем — нет ли ещё
//     опасной цели в радиусе агро прямо сейчас; если есть — не трогаем
//     юнита в этом тике (пусть локальный автопоиск, уже усиленный пунктом
//     1, сам подхватит её на ближайшем тике updateCombat).
//
// Не переопределяем attackerCandidateIds/бой-приоритет "кто нас атакует"
// (ИИ №35) — он остаётся ПЕРВЫМ приоритетом, это не отменяется: если нас
// уже атакуют — добиваем атакующего, а не переключаемся на другую турель
// просто потому что она "опаснее" по типу. "Опасность по типу" (canAttack)
// это ВТОРОЙ приоритет, применяется только если по нас прямо сейчас никто
// не бьёт.
//
// Подключать ПОСЛЕДНИМ в index.html, после js/29-wall-breach-or-detour.js
// (не после 19-...js напрямую — оборачиваем ТЕКУЩУЮ, уже единожды
// пропатченную findNearestEnemyInRange, а не переопределяем её заново с
// нуля, чтобы не потерять приоритет "бей атакующего" из ИИ №35).

(function patchFindNearestEnemyInRangeForDangerPriority() {
  if (typeof findNearestEnemyInRange !== "function") return;
  const _findNearestEnemyInRangeWithAttackerPriority = findNearestEnemyInRange;

  findNearestEnemyInRange = function (u, range) {
    // Приоритет №1 (ИИ №35, не трогаем): кто-то уже атакует именно нас —
    // сохраняем поведение как есть, полностью полагаясь на оригинал.
    const attackerPriorityResult = _findNearestEnemyInRangeWithAttackerPriority(u, range);
    if (attackerPriorityResult && attackerPriorityResult.attackTargetId === u.id) {
      return attackerPriorityResult;
    }

    // Приоритет №2 (НОВОЕ): среди целей в радиусе — ближайшая ОПАСНАЯ
    // (canAttack==true у её type-определения), даже если она пока не
    // бьёт по нам. Турель/мортира/стреляющий юнит, замеченные на подходе,
    // важнее случайно более близкого невооружённого здания.
    let bestDangerous = null, bestDangerousD = Infinity;

    function typeCanAttack(entity) {
      const isUnit = !!State.units[entity.id];
      const table = isUnit ? UnitDefs : BuildingDefs;
      const def = table[entity.type];
      return !!(def && def.canAttack);
    }

    function consider(other) {
      if (other.hp <= 0) return;
      if (!isEnemyOf(u.ownerId, other.ownerId)) return;
      if (other.type === "wall" && other.constructionMsLeft > 0) return; // призрачная стена — та же защита, что и в 07-...js
      const d = dist(u.x, u.y, other.x, other.y);
      if (d > range) return;
      if (typeCanAttack(other) && d < bestDangerousD) { bestDangerous = other; bestDangerousD = d; }
    }
    Object.values(State.units).forEach(consider);
    Object.values(State.buildings).forEach(consider);

    // Опасная цель есть в радиусе — приоритет ей. Если нет — обычный
    // фолбэк на глобально ближайшего врага (штаб/любое другое здание) —
    // ровно то, что вернул бы и оригинал (attackerPriorityResult уже
    // посчитан выше, переиспользуем его напрямую, чтобы не делать один и
    // тот же проход по State дважды подряд).
    return bestDangerous || attackerPriorityResult;
  };
})();

/* ==================================================================
   Стратегический уровень: не пере-приказывать юнита сразу на hq, если
   рядом (в радиусе агро attack-move) ещё есть непогашенная угроза —
   пусть автопоиск (уже усиленный патчем выше) сначала её добьёт.
   ================================================================== */
(function patchEnemyAttackStepForDangerPriority() {
  if (typeof enemyAttackStep !== "function") return;
  if (typeof findNearestEnemyInRange !== "function") return;

  const _enemyAttackStepOriginal = enemyAttackStep;

  // Есть ли опасная (canAttack) цель в радиусе агро attack-move ПРЯМО
  // СЕЙЧАС рядом с юнитом — та же проверка типа, что и в патче выше,
  // продублирована здесь намеренно (не завязываемся на внутренности
  // findNearestEnemyInRange, чтобы не тянуть приватную функцию наружу —
  // здесь достаточно самого факта "есть ли рядом хоть одна опасная цель",
  // не важно какая именно).
  function hasDangerousTargetNearby(u, range) {
    let found = false;
    Object.values(State.units).forEach(other => {
      if (found || other.hp <= 0) return;
      if (!isEnemyOf(u.ownerId, other.ownerId)) return;
      const def = UnitDefs[other.type];
      if (!def || !def.canAttack) return;
      if (dist(u.x, u.y, other.x, other.y) <= range) found = true;
    });
    if (found) return true;
    Object.values(State.buildings).forEach(other => {
      if (found || other.hp <= 0) return;
      if (!isEnemyOf(u.ownerId, other.ownerId)) return;
      if (other.type === "wall" && other.constructionMsLeft > 0) return;
      const def = BuildingDefs[other.type];
      if (!def || !def.canAttack) return;
      if (dist(u.x, u.y, other.x, other.y) <= range) found = true;
    });
    return found;
  }

  enemyAttackStep = function () {
    const combat = enemyUnits().filter(u => UnitDefs[u.type] && UnitDefs[u.type].canAttack);
    if (combat.length === 0) { _enemyAttackStepOriginal(); return; }

    const playerBuildings = Object.values(State.buildings).filter(b => b.ownerId === localPlayerId && b.hp > 0);
    if (playerBuildings.length === 0) { _enemyAttackStepOriginal(); return; }

    // Юниты, которые оригинал СЕЙЧАС переприказал бы на hq (arrivedAndIdle
    // === idle && !attackTargetId), но у которых рядом ещё есть непогашенная
    // угроза — временно "придерживаем" (не даём оригиналу их тронуть),
    // подсовывая фиктивный attackTargetId на один тик. updateCombat
    // (07-...js) на следующем шаге сам найдёт эту угрозу автопоиском (idle
    // без attackTargetId ИЛИ attackMoveMode — оба условия срабатывают,
    // патч выше уже даёт ей приоритет) и включит бой — этот патч не бьёт
    // сам, только не мешает автопоиску сработать первым, не давая
    // enemyAttackStep перебить его свежим attack-move приказом на hq в тот
    // же самый тик.
    //
    // Технически: временно проставляем attackTargetId=null остаётся как
    // есть — мы НЕ трогаем сами юниты здесь заранее (не дублируем
    // findNearestEnemyInRange бой-логику), просто на время вызова
    // оригинала подменяем их видимость в enemyUnits(), исключая из списка
    // combat тех, у кого рядом есть угроза — оригинал их просто не увидит
    // и не переприказывает, а следующий вызов updateCombat (тот же тик,
    // порядок вызовов в gameTick: движение -> updateCombat -> ... ->
    // updateEnemyStub) их подхватит автопоиском.
    const held = new Set();
    combat.forEach(u => {
      const arrivedAndIdle = u.state === "idle" && !u.attackTargetId;
      if (arrivedAndIdle && hasDangerousTargetNearby(u, ATTACK_MOVE_AGGRO_BONUS)) {
        held.add(u.id);
      }
    });

    if (held.size === 0) { _enemyAttackStepOriginal(); return; }

    // Временная подмена enemyUnits() на время вызова оригинала — самый
    // безопасный способ "спрятать" придержанных юнитов от переприказа, не
    // копируя тело enemyAttackStep целиком (та же осторожность, что и
    // остальной проект — не дублировать функции 1:1 без необходимости).
    const _enemyUnitsOriginal = enemyUnits;
    enemyUnits = function () {
      return _enemyUnitsOriginal().filter(u => !held.has(u.id));
    };
    try {
      _enemyAttackStepOriginal();
    } finally {
      enemyUnits = _enemyUnitsOriginal;
    }
  };
})();
