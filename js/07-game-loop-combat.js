/* ---------------------------- Игровой цикл (тик логики) ---------------------------- */

// ИИ №20: потолок dtMs, используемого ИМЕННО для физического шага движения
// юнитов (см. коммент-обоснование у блока движения ниже, "БАГФИКС —
// дёргается туда-сюда"). gameTick вызывается из requestAnimationFrame с
// РЕАЛЬНОЙ дельтой между кадрами (не фиксированный tickRateMs=100 —
// tickRateMs сейчас нигде фактически не используется как шаг симуляции,
// это отдельный факт, см. TODO при желании сделать полноценный fixed-step).
// На лаг-спайке (вкладка была в фоне и вернулась в фокус, GC-пауза,
// медленный кадр) dtMs может быть аномально большим (сотни мс, после
// длительного сворачивания вкладки — секунды), что раньше приводило к
// огромному "step" за один кадр и проскакиванию юнитом его текущей цели
// движения насквозь. 100мс — сознательно равно "одному логическому тику"
// по духу проекта (см. tickRateMs), достаточно щедро для обычных
// просадок FPS (тройной кадр при 60fps все ещё укладывается), но не даёт
// одному кадру эмулировать секунды движения разом.
const MOVE_MAX_DT_MS = 100;

// ИИ №29: findNearestDropoff/весь харвест-конвейер (ноды, cargo, "returning")
// убраны вместе с юнитом worker — добыча ресурсов теперь пассивна, см.
// updateRefineries ниже. Функция оставлена как no-op-заглушка НЕ нужна:
// ни один оставшийся файл её больше не вызывает (проверено), поэтому
// просто удалена, а не оставлена мёртвым кодом.

// ИИ №29: ЗАМЕНА добычи через юнита-рабочего на пассивный доход от зданий
// refinery (см. BuildingDefs, 01-config-state.js). Каждое живое (hp>0)
// здание типа refinery раз в тик начисляет владельцу incomePerTick
// кредитов — без юнитов, без ресурсных нод, без пути на базу. Простая
// линейная модель по духу остальной экономики прототипа (см.
// updatePowerAndUnitCounts ниже — тоже просто суммирует по всем зданиям
// владельца каждый тик).
function updateRefineries() {
  Object.values(State.buildings).forEach(b => {
    if (b.hp <= 0) return;
    const def = BuildingDefs[b.type];
    if (!def || !def.incomePerTick) return;
    const player = State.players[b.ownerId];
    if (!player) return;
    player.credits += def.incomePerTick;
  });
}

function gameTick(dtMs) {
  State.tick++;

  // Движение юнитов
  // ИИ №29: юнит worker и его states "moving-to-harvest"/"returning"
  // убраны вместе со всей механикой добычи (см. updateRefineries выше) —
  // физически двигающихся states у оставшихся юнитов теперь только
  // "moving". ВНИМАНИЕ следующему ИИ: список ниже — тот самый
  // критичный инвариант из раздела "грабли" промпт-документа: любой
  // новый "движущийся" state юнита ОБЯЗАН быть добавлен сюда, иначе
  // юнит получит targetX/Y, но не сдвинется физически.
  Object.values(State.units).forEach(u => {
    const def = UnitDefs[u.type];
    if (u.state === "moving" && u.targetX != null) {
      const d = dist(u.x, u.y, u.targetX, u.targetY);
      if (d < 2) {
        // ИИ №7 (патфайндинг): если это не последняя точка маршрута —
        // переходим к следующему waypoint из u.path, не меняя state.
        // Раньше targetX/targetY были ровно конечной точкой приказа,
        // теперь это очередная точка A*-пути; "дошли" тут означает
        // "дошли до текущего waypoint", а не обязательно до цели.
        if (u.path && u.path.length > 1) {
          u.path.shift();
          const next = u.path[0];
          u.targetX = next.x; u.targetY = next.y;
        } else {
          // ИИ №29: раньше здесь была отдельная ветка для
          // state==="moving-to-harvest" (targetX/Y нарочно не сбрасывались,
          // следующий блок харвеста переключал state сам). Юнит worker и
          // харвест убраны — единственный оставшийся движущийся state это
          // "moving", ветвление больше не нужно.
          u.path = null;
          u.state = "idle";
          u.targetX = null; u.targetY = null;
        }
      } else {
        // ИИ №20: БАГФИКС — "юнит стоит и дёргается туда-сюда, не доходит
        // до цели/штаба", воспроизводилось ДАЖЕ у одного юнита в пустом
        // поле, без соседей и без боя (репорт пользователя). Причина: dtMs
        // здесь — реальная дельта между кадрами requestAnimationFrame (см.
        // loop() в 08-render.js), НЕ фиксированные 100мс логического тика.
        // Любой лаг-спайк кадра (сворачивание вкладки/фокус назад,
        // GC-пауза, долгая загрузка) даёт аномально большой dtMs, отсюда
        // — аномально большой "step". Раньше step ничем не ограничивался
        // относительно d (оставшейся дистанции до текущего waypoint):
        // если step > d, юнит проскакивал waypoint НАСКВОЗЬ и оказывался
        // на противоположной стороне от него (или ещё дальше). Проверка
        // "d<2" в начале блока не срабатывала для ЭТОГО кадра (юнит был
        // ещё не близко к цели ДО шага), поэтому path/state не
        // продвигались — на следующем кадре юнит шёл обратно к той же
        // точке и мог снова проскочить (на возврате или на следующем
        // лаг-кадре) — экспоненциально расходящееся дёрганье вперёд-назад
        // вместо схождения к цели, без необходимости во втором юните и
        // без боевой логики. Фикс — два независимых слоя:
        //  1) dtMs, используемый для движения, ограничен потолком
        //     MOVE_MAX_DT_MS — один длинный кадр не даёт юниту улететь на
        //     сотни px за один тик рендера.
        //  2) Сам step дополнительно клампится к d — юнит физически не
        //     может пройти дальше остатка пути до текущего waypoint за
        //     один вызов; итог движения — ровно targetX/targetY, не дальше.
        //     Это не мешает нормальному "дошли" (d<2) на следующем кадре
        //     обработать смену waypoint/state как раньше.
        const safeDtMs = Math.min(dtMs, MOVE_MAX_DT_MS);
        const step = Math.min(def.speed * (safeDtMs / 16.6), d);
        u.x += (u.targetX - u.x) / d * step;
        u.y += (u.targetY - u.y) / d * step;
      }
    }

  });

  applyUnitSeparation(dtMs);
  updateCombat(dtMs);
  updateProductionQueues(dtMs);
  updateRefineries(); // ИИ №29: пассивный доход от зданий refinery (замена харвеста рабочими)
  // ИИ №30 (мультиплеер): в PvP-режиме нет enemy_ai — противник управляется
  // другим клиентом и приходит через remote-снапшот (см. 18-pvp-multiplayer.js,
  // applyRemoteSnapshotToState). MultiplayerMode всегда определён (01), дефолт
  // "ai" — вызов updateEnemyStub для существующих партий против бота не меняется.
  if (MultiplayerMode.mode !== "pvp") {
    updateEnemyStub(dtMs);
  }
  updatePowerAndUnitCounts();
  recomputeFogOfWar(); // ИИ №6: после боя/движения — чтобы видимость учитывала актуальные позиции
  renderHUD();
  renderSelectionPanel(); // обновляем HP/прогресс построек в панели выделения каждый тик
}

/* ---------------------------- Боевая система ---------------------------- */
// ИИ №3: полноценная (для прототипа) боевая система.
// Правила:
//  - Юнит с canAttack и attackTargetId!=null пытается держать дистанцию
//    attackRange от цели: если дальше — идёт к ней, если в радиусе — бьёт
//    по attackCooldown, останавливаясь на месте (не сближается зря).
//  - Если attackTargetId не задан явно игроком, но юнит стоит на месте
//    (state==="idle") ИЛИ движется в режиме attack-move
//    (attackMoveMode===true), юнит сам ищет ближайшего врага в радиусе
//    автоагра (чуть больше attackRange) и атакует его. Обычное движение
//    (state==="moving" без attackMoveMode) НЕ триггерит автоатаку —
//    юнит просто идёт мимо, как задумано (проверено в изолированном
//    node-тесте, см. футер файла).
//  - Здания НЕ атакуют сами (турелей пока нет — см. футер), но МОГУТ быть
//    целью атаки юнитов.
//  - При hp<=0 — юнит/здание удаляется из State, снятие с выделения, лог.

const AUTO_AGGRO_BONUS = 40; // юниты замечают врагов чуть дальше своей атаки, но не через полкарты

// ИИ №40: по прямому запросу пользователя — "ИИ должен сам подводить юнитов
// к опасным турелям или юнитам, которых он встретил по дороге, а не слепо
// направлять их в базу игрока". Раньше юнит в attackMoveMode пользовался тем
// же AUTO_AGGRO_BONUS (+40px), что и стоящий на месте idle-юнит — этого было
// мало, чтобы заметить турель (attackRange 170, см. 01-config-state.js)
// заранее: юнит "видел" её только когда УЖЕ входил в радиус её обстрела, а
// не по пути мимо. ATTACK_MOVE_AGGRO_BONUS даёт заметно больший радиус
// обнаружения ИМЕННО юнитам, идущим attack-move (в бой/патрулём) — стоящие
// на месте idle-юниты (обычный автоагр без attack-move) это не затрагивает,
// они по-прежнему используют AUTO_AGGRO_BONUS, как и раньше — идущий мимо
// одиночный юнит без приказа attack-move не должен вдруг реагировать на всё
// вокруг на полкарты. 160px подобрано так, чтобы юнит замечал турель
// (range 170) и дальнобойную пехоту (sniper 270 сознательно не покрываем
// полностью — заметить снайпера издалека раньше, чем он откроет огонь,
// было бы уже "видением через полкарты", а не разумной бдительностью на
// марше) заметно раньше, чем окажется под их обстрелом.
const ATTACK_MOVE_AGGRO_BONUS = 160;

// ИИ №24: "поводок" преследования — по запросу пользователя ("юниты
// должны заходить за радиус точки, которую я поставил, и возвращаться
// обратно"). Раньше юнит в attack-move мог убежать за атакующей целью
// сколь угодно далеко от точки, куда его изначально направил игрок —
// attack-move у одного щуплого стрелка мог утащить его прямо во вражескую
// базу вслед за отступающим противником. CHASE_LEASH_RADIUS — максимальное
// удаление от u.attackMoveHomeX/Y (см. 01-config-state.js), при превышении
// которого updateCombat принудительно прерывает бой и возвращает юнита
// на исходную точку (см. блок в updateCombat ниже). Достаточно большой,
// чтобы не мешать обычным стычкам в attackRange у самой точки, но не даёт
// увести юнита через полкарты.
const CHASE_LEASH_RADIUS = 190;
// ИИ №24: после того как leash сработал (см. блок в updateCombat ниже) и
// юнит идёт назад через setUnitDestination, u.state временно "moving" (не
// "idle"), но u.attackMoveMode остаётся true всё это время. Как только
// физическое движение (блок в начале gameTick) доводит юнита до
// attackMoveHomeX/Y и переключает state обратно в "idle" — автопоиск цели
// в updateCombat (условие `u.state === "idle" || u.attackMoveMode`) СРАЗУ
// же снова начинает подхватывать врагов в радиусе точки, без какого-либо
// отдельного "разбудить юнита" кода — attackMoveMode и так уже true.

function findAttackableAt(id) {
  return State.units[id] || State.buildings[id] || null;
}

function isEnemyOf(ownerId, otherOwnerId) {
  return ownerId !== otherOwnerId; // прототип: все чужие владельцы = враги (нет команд/альянсов)
}

function findNearestEnemyInRange(u, range) {
  let best = null, bestD = Infinity;
  Object.values(State.units).forEach(other => {
    if (other.hp <= 0) return;
    if (!isEnemyOf(u.ownerId, other.ownerId)) return;
    const d = dist(u.x, u.y, other.x, other.y);
    if (d <= range && d < bestD) { best = other; bestD = d; }
  });
  Object.values(State.buildings).forEach(other => {
    if (other.hp <= 0) return;
    if (!isEnemyOf(u.ownerId, other.ownerId)) return;
    const d = dist(u.x, u.y, other.x, other.y);
    if (d <= range && d < bestD) { best = other; bestD = d; }
  });
  return best;
}

function killUnit(id) {
  const u = State.units[id];
  if (!u) return;
  const def = UnitDefs[u.type];
  State.selection.delete(id);
  delete State.units[id];
  logMsg(`${def ? def.label : "Юнит"} (${u.ownerId === localPlayerId ? "ваш" : "противника"}) уничтожен`,
    u.ownerId === localPlayerId ? "warn" : "enemy");
}

function killBuilding(id) {
  const b = State.buildings[id];
  if (!b) return;
  const def = BuildingDefs[b.type];
  State.selection.delete(id);
  delete State.buildings[id];
  logMsg(`Здание разрушено: ${def ? def.label : b.type}`, b.ownerId === localPlayerId ? "warn" : "enemy");
}

function updateCombat(dtMs) {
  Object.values(State.units).forEach(u => {
    const def = UnitDefs[u.type];
    if (!def || !def.canAttack) return;

    if (u.attackCooldownLeft > 0) u.attackCooldownLeft -= dtMs;

    // ИИ №24: если юнит только что вошёл в attack-move (attackMoveMode===true),
    // но attackMoveHomeX/Y ещё не проставлены (либо это старый юнит без
    // этого поля, либо 09-input.js/06-enemy-ai.js не выставили его сами) —
    // фиксируем ТЕКУЩУЮ pathGoal как точку "дома" фолбэком. pathGoalX/Y —
    // конечная точка приказа (см. 03-pathfinding.js, setUnitDestination),
    // это ровно то место, куда игрок указал attack-move, так что фолбэк
    // безопасен и не требует правок в 09-input.js для базовой работы.
    // Проверка attackMoveHomeX==null (не !==) гарантирует, что мы не
    // перезаписываем уже сохранённую точку на каждом тике — только один
    // раз при первом обнаружении attack-move без home.
    if (u.attackMoveMode && u.attackMoveHomeX == null) {
      u.attackMoveHomeX = u.pathGoalX != null ? u.pathGoalX : u.x;
      u.attackMoveHomeY = u.pathGoalY != null ? u.pathGoalY : u.y;
    }
    // Как только юнит покидает attack-move (обычный move/idle без него) —
    // сбрасываем home, чтобы старая точка не "просачивалась" в следующий
    // attack-move приказ по ошибке (свежий приказ либо переустановит home
    // явно из 09-input.js/06, либо снова сработает фолбэк выше).
    if (!u.attackMoveMode) {
      u.attackMoveHomeX = null;
      u.attackMoveHomeY = null;
    }

    // 1) Явная цель (приказ игрока/attack-move нашёл цель) — приоритет.
    let target = u.attackTargetId ? findAttackableAt(u.attackTargetId) : null;
    if (target && target.hp <= 0) { target = null; u.attackTargetId = null; }

    // ИИ №24: "поводок" — если юнит в attack-move (есть сохранённая точка
    // attackMoveHomeX/Y) и его ТЕКУЩАЯ позиция уже ушла за пределы
    // CHASE_LEASH_RADIUS от этой точки — прерываем бой прямо сейчас, ДО
    // автопоиска новой цели ниже, иначе юнит мог бы тут же нахватать
    // следующую цель и продолжить убегать ещё дальше. Сбрасываем
    // attackTargetId и отправляем юнита назад через setUnitDestination
    // (ЕДИНАЯ точка входа для движения, см. 03-pathfinding.js — так же,
    // как и остальной код проекта). attackMoveMode оставляем true — юнит
    // должен снова начать реагировать на врагов, как только дойдёт до
    // точки, а не "разучиться" атаковать (см. ниже, при прибытии домой).
    if (u.attackMoveMode && u.attackMoveHomeX != null) {
      const homeD = dist(u.x, u.y, u.attackMoveHomeX, u.attackMoveHomeY);
      if (homeD > CHASE_LEASH_RADIUS) {
        target = null;
        u.attackTargetId = null;
        if (u.pathGoalX !== u.attackMoveHomeX || u.pathGoalY !== u.attackMoveHomeY) {
          setUnitDestination(u, u.attackMoveHomeX, u.attackMoveHomeY);
        }
        u.state = "moving";
        return; // пропускаем автопоиск/бой в этом тике — юнит уже приказан домой
      }
    }

    // 2) Автопоиск: если нет явной цели, но юнит стоит на месте (idle)
    //    ИЛИ находится в attack-move — ищем врага в радиусе автоагра.
    // ИИ №40: у attack-move радиус обнаружения заметно больше (см.
    // ATTACK_MOVE_AGGRO_BONUS выше) — юнит, идущий в атаку/патрулём, должен
    // сам заметить и подвести себя к опасным турелям/юнитам по дороге, а не
    // только к тем, что оказались прямо под носом. У чистого idle (стоит на
    // месте без attack-move) поведение НЕ меняется — обычный AUTO_AGGRO_BONUS,
    // как и раньше.
    if (!target && (u.state === "idle" || u.attackMoveMode)) {
      const aggroBonus = u.attackMoveMode ? ATTACK_MOVE_AGGRO_BONUS : AUTO_AGGRO_BONUS;
      const found = findNearestEnemyInRange(u, def.attackRange + aggroBonus);
      if (found) {
        target = found;
        u.attackTargetId = found.id;
      }
    }

    if (!target) return;

    const d = dist(u.x, u.y, target.x, target.y);
    if (d > def.attackRange) {
      // сближаемся с целью. Цель может двигаться, так что путь
      // пересчитываем только если она заметно сместилась с прошлого
      // расчёта (иначе A* гонялся бы за каждым мелким шагом врага).
      // ИИ №12: для flying-юнитов (aircraft) это условие тоже работает —
      // setUnitDestination сам решает A*/прямая по def.flying, здесь
      // ничего дополнительно проверять не нужно.
      if (u.state !== "moving" || u.pathGoalX == null || dist(u.pathGoalX, u.pathGoalY, target.x, target.y) > PATH_GRID_SIZE) {
        setUnitDestination(u, target.x, target.y);
      }
      u.state = "moving";
    } else {
      // в радиусе — стоим и бьём (останавливаем движение к цели). Сравниваем
      // с pathGoalX/Y (конечная цель приказа), а не с targetX/Y напрямую,
      // потому что targetX/Y теперь может быть промежуточным waypoint
      // A*-маршрута, а не самой целью.
      if (u.state === "moving" && u.pathGoalX === target.x && u.pathGoalY === target.y) {
        u.state = "idle"; u.targetX = null; u.targetY = null; u.path = null;
      }
      if (u.attackCooldownLeft <= 0) {
        target.hp -= def.attackDamage;
        u.attackCooldownLeft = def.attackCooldown;
        if (target.hp <= 0) {
          if (State.units[target.id]) killUnit(target.id);
          else if (State.buildings[target.id]) killBuilding(target.id);
          u.attackTargetId = null;
        }
      }
    }
  });

  updateDefensiveStructures(dtMs);
}

// ИИ №5: оборонные здания (сейчас только turret, см. BuildingDefs). Раньше
// (см. футер ИИ №3/№4) здания НИКОГДА не атаковали сами — это был явный
// TODO. Логика заметно проще, чем у юнитов, потому что здание не двигается:
// нет веток "сближаемся"/"attack-move"/"idle-автоагро в движении" — просто
// каждый тик ищем ближайшего врага в радиусе attackRange и бьём по
// кулдауну, если он есть. Приоритет цели: если текущая цель ещё жива и
// в радиусе — продолжаем бить именно её (не дёргаемся на новую цель
// просто потому что она чуть ближе) — иначе турель могла бы никогда не
// добивать никого при плотной толпе атакующих. Раз в тик (не только раз в
// decision-интервал ИИ) переоценка нужна и для зданий игрока, поэтому это
// не завязано на enemyFsm/ENEMY_DECISION_INTERVAL.
function updateDefensiveStructures(dtMs) {
  Object.values(State.buildings).forEach(b => {
    const def = BuildingDefs[b.type];
    if (!def || !def.canAttack) return;
    if (b.attackCooldownLeft == null) b.attackCooldownLeft = 0;
    if (b.attackCooldownLeft > 0) b.attackCooldownLeft -= dtMs;

    let target = b.attackTargetId ? findAttackableAt(b.attackTargetId) : null;
    if (target) {
      if (target.hp <= 0 || !isEnemyOf(b.ownerId, target.ownerId)) target = null;
      else if (dist(b.x, b.y, target.x, target.y) > def.attackRange) target = null; // вышел из радиуса — ищем другую цель
    }
    if (!target) {
      target = findNearestEnemyInRange(b, def.attackRange);
      b.attackTargetId = target ? target.id : null;
    }
    if (!target) return;

    if (b.attackCooldownLeft <= 0) {
      target.hp -= def.attackDamage;
      b.attackCooldownLeft = def.attackCooldown;
      if (target.hp <= 0) {
        if (State.units[target.id]) killUnit(target.id);
        else if (State.buildings[target.id]) killBuilding(target.id);
        b.attackTargetId = null;
      }
    }
  });
}

/* ---------------------------- Separation юнитов ---------------------------- */
// ИИ №14: ВОССТАНОВЛЕНА. Журнал цепочки (запись ИИ №10) описывал эту
// функцию, но фактический код отсутствовал в файле, присланном ИИ №12 И
// ИИ №13 (см. их пометки в разделе 2/3 PROMPT_FOR_NEXT_AI.md) — три
// плеча цепочки подряд получали 07-game-loop-combat.js БЕЗ неё, при этом
// gameTick вызывал updateCombat напрямую. Здесь код написан заново по
// описанию из журнала/раздела 3 промпта, не восстановлен из старой копии
// (её не было ни у одного из присланных файлов).
//
// Простое попарное отталкивание живых юнитов по UnitDefs[type].bodyRadius.
// Намеренно НЕ сетка — O(n²) по живым юнитам, что признано приемлемым в
// журнале (тот же выбор подтверждён ИИ №10/№12/№13 в комментариях раздела
// 3 промпта: "не пытайся сливать с патфайндингом/фогом без крайней
// необходимости").
//
// Правила:
//  - Только между ЖИВЫМИ юнитами (hp>0), не зданиями — здания не двигаются
//    и уже обходятся патфайндингом (occupancy-сетка в 03-pathfinding.js).
//  - Flying-юниты (UnitDefs[type].flying===true, сейчас aircraft) ПОЛНОСТЬЮ
//    исключены — ни толкают, ни толкаются, ни с наземными, ни друг с
//    другом. В воздухе нет физической тесноты между летающими и наземными
//    юнитами (см. раздел 3 промпта, пункт "Летающие юниты").
//  - Между врагами в АКТИВНОМ БОЮ (хотя бы у одного из пары есть
//    attackTargetId, указывающий друг на друга ИЛИ просто есть
//    attackTargetId вообще) — отталкивания нет. Иначе бойцы, сошедшиеся в
//    attackRange, не могли бы стабильно стоять и обмениваться уроном —
//    их бы постоянно расталкивало (см. раздел 3 промпта, "Separation
//    юнитов" и п.3 задачи ИИ №12). Проверяем именно "есть attackTargetId
//    хотя бы у одного" (не обязательно друг на друга) — это соответствует
//    формулировке промпта буквально и не даёт разведению мешать даже
//    тройным/групповым замесам, где A бьёт B, а B бьёт C.
//  - Сила отталкивания пропорциональна перекрытию (сумма bodyRadius минус
//    расстояние между центрами), симметрично раздвигает оба юнита на
//    половину перекрытия каждого, масштабируется по dtMs так же, как
//    обычное движение (ссылка на dtMs/16.6 — тот же приём, что и в блоке
//    движения выше в gameTick).
//  - Если два юнита оказались в одной точке (d===0) — считаем крошечное
//    d, чтобы не делить на ноль, направление раздвижения детерминировано
//    (по разнице id), а не случайно.
// ИИ №18: БАГФИКС — "юниты не доходят до точки/до штаба с грузом" (репорт
// пользователя). Когда много юнитов шли в одну и ту же точку (толпа к
// одному штабу, отряд attack-move и т.п.), overlap у самой цели становился
// большим, push — сравним с шагом движения за тик или даже больше него:
// separation отбрасывала юнита почти на весь шаг, который он только что
// сделал к цели, приближение затухало почти до нуля вместо линейного (см.
// репро в журнале/PROMPT_FOR_NEXT_AI.md). SEPARATION_MAX_PUSH ограничивает
// толчок за тик потолком, заметно меньшим типичной скорости юнита —
// толкотня продолжает расталкивать плотную толпу (просто медленнее гасит
// наложение), но больше не может пересилить/свести на нет прогресс
// движения к цели. Deadzone/бой/flying не тронуты — эффект проявляется
// только там, где overlap аномально велик, то есть именно в сценарии "все
// идут в одну точку".
const SEPARATION_STRENGTH = 0.5; // доля перекрытия, устраняемая за один "полный" тик (16.6мс)
const SEPARATION_MAX_PUSH = 0.9; // px за "полный" тик (16.6мс) — потолок толчка, см. коммент ИИ №18
// ИИ №16: БАГФИКС — "рабочие дёргают носиком туда-сюда" (репорт пользователя).
// Причина: без порога любое, даже исчезающе малое перекрытие (0.01px) давало
// ненулевой push, юнит сдвигался, на следующем тике снова оказывался чуть
// перекрыт (или перелетал на противоположную сторону) — толчок срабатывал
// заново в другую сторону, и так каждый тик до бесконечности (визуально —
// дрожь/подёргивание на месте). SEPARATION_DEADZONE — гистерезис: перекрытие
// меньше этого порога считается "уже устранённым" и не толкает юнитов.
const SEPARATION_DEADZONE = 1.5; // px, ниже этого overlap разведение не применяется

function applyUnitSeparation(dtMs) {
  const units = Object.values(State.units).filter(u => u.hp > 0);
  const factor = Math.min(1, dtMs / 16.6) * SEPARATION_STRENGTH;

  for (let i = 0; i < units.length; i++) {
    const a = units[i];
    const defA = UnitDefs[a.type];
    if (!defA || defA.flying) continue;

    for (let j = i + 1; j < units.length; j++) {
      const b = units[j];
      const defB = UnitDefs[b.type];
      if (!defB || defB.flying) continue;

      // не разводим пару, если хотя бы один из них сейчас в активном бою —
      // иначе стабильно стоящих в attackRange бойцов будет постоянно
      // расталкивать (см. комментарий-обоснование выше).
      if (a.attackTargetId || b.attackTargetId) continue;

      const rA = defA.bodyRadius != null ? defA.bodyRadius : 12;
      const rB = defB.bodyRadius != null ? defB.bodyRadius : 12;
      const minDist = rA + rB;

      let dx = a.x - b.x, dy = a.y - b.y;
      let d = Math.hypot(dx, dy);
      if (d >= minDist) continue; // не перекрываются — расталкивать нечего

      if (d < 0.0001) {
        // полностью совпавшие координаты — раздвигаем детерминированно
        // по сравнению id, чтобы не звать Math.random() (соглашение
        // проекта — pickInfantryType в 06-enemy-ai.js тоже избегает
        // Math.random для детерминированности, см. журнал ИИ №13).
        const dir = a.id < b.id ? 1 : -1;
        dx = dir; dy = 0; d = 1;
      }

      const overlap = minDist - d;
      if (overlap < SEPARATION_DEADZONE) continue; // ИИ №16: гасим дрожь на границе — см. коммент выше

      // ИИ №18: потолок толчка — см. коммент-обоснование над
      // SEPARATION_MAX_PUSH выше. Без него push мог расти неограниченно
      // вместе с overlap (толпа юнитов, сходящихся в одну точку) и
      // пересиливать обычное движение к цели.
      const push = Math.min(overlap * factor, SEPARATION_MAX_PUSH);
      const ux = dx / d, uy = dy / d;

      a.x += ux * push * 0.5;
      a.y += uy * push * 0.5;
      b.x -= ux * push * 0.5;
      b.y -= uy * push * 0.5;
    }
  }
}

/* ---------------------------- Очередь производства ---------------------------- */
// ИИ №3: у зданий теперь buildQueue — массив {unitType, msLeft, totalMs}.
// tryTrainUnit() (см. ниже) больше не создаёт юнита мгновенно, а ставит
// заказ в очередь конкретного здания. Здесь мы продвигаем прогресс и
// выпускаем готового юнита рядом со зданием (в rallyX/rallyY).
//
// ИИ №21: РЕШЁН открытый TODO №2 из PROMPT_FOR_NEXT_AI.md ("power/powerUse
// считаются, но ни на что не влияют — нет штрафа/отключения при дефиците").
// Выбран вариант "реализовать эффект" (а не "закрыть как не в скоупе"),
// т.к. и HUD (resPower, 10-hud.js), и updatePowerAndUnitCounts уже честно
// считают эти числа каждый тик — оставлять их чисто декоративными означало
// бы держать в игре видимую механику, которая ничего не делает, что само
// по себе сбивает с толку игрока (зачем тогда строить электростанцию?).
//
// Эффект — штраф СКОРОСТИ производства при дефиците питания (use>power),
// а НЕ полная остановка очереди. Выбрано так намеренно:
//  - Полная остановка при малейшем дефиците — слишком жёстко для прототипа
//    (одно потерянное здание из-за атаки могло бы мгновенно заморозить всю
//    экономику) и не даёт игроку "закончить то, что уже почти готово" —
//    фрустрирующе без явной визуальной причины.
//  - Пропорциональный штраф (см. POWER_DEFICIT_* ниже) масштабируется по
//    ГЛУБИНЕ дефицита (насколько use превышает power), а не бинарно —
//    небольшая нехватка ощутимо тормозит, но не парализует; серьёзная
//    нехватка (например, потеряны все электростанции) душит производство
//    почти полностью (до POWER_DEFICIT_MIN_RATE), но не до нуля — застрять
//    в полной невозможности произвести хоть что-то без явного пути выхода
//    было бы тупиком, а не осмысленным риском.
//  - Штраф читается из p.power/p.powerUse ПРЕДЫДУЩЕГО тика (см. порядок
//    вызовов в gameTick — updateProductionQueues идёт РАНЬШЕ
//    updatePowerAndUnitCounts в этом же файле). Задержка в один тик
//    (100мс) не имеет игрового значения и НАМЕРЕННО не устраняется
//    перестановкой порядка вызовов — трогать порядок вызовов в gameTick
//    без крайней необходимости рискует задеть другую логику, полагающуюся
//    на текущий порядок (общий принцип "не трогай то, что не сломано" из
//    раздела 3 промпта).
const POWER_DEFICIT_MIN_RATE = 0.25; // потолок замедления — даже при полном дефиците производство не встаёт совсем
function powerRateMultiplier(ownerId) {
  const player = State.players[ownerId];
  if (!player) return 1;
  const power = player.power || 0;
  const use = player.powerUse || 0;
  if (use <= power) return 1; // нет дефицита (в т.ч. use===0) — обычная скорость
  // Глубина дефицита как доля от потребности: 0 = нет дефицита, 1 = вообще
  // нет питания при ненулевом потреблении. clamp() определена в 08-render.js
  // и подключается раньше по порядку — доступна к моменту вызова этой
  // функции (вызывается из gameTick, не при загрузке файла).
  const deficitRatio = clamp((use - power) / use, 0, 1);
  // Линейная интерполяция между полной скоростью (1x) и минимальной
  // (POWER_DEFICIT_MIN_RATE) по глубине дефицита.
  return 1 - deficitRatio * (1 - POWER_DEFICIT_MIN_RATE);
}

function updateProductionQueues(dtMs) {
  Object.values(State.buildings).forEach(b => {
    if (!b.buildQueue || b.buildQueue.length === 0) return;
    const order = b.buildQueue[0];
    const rate = powerRateMultiplier(b.ownerId);
    order.msLeft -= dtMs * rate;
    if (order.msLeft <= 0) {
      const def = UnitDefs[order.unitType];
      const id = uid("u");
      State.units[id] = {
        id, ownerId: b.ownerId, type: order.unitType,
        x: b.rallyX + (Math.random() * 20 - 10), y: b.rallyY + (Math.random() * 20 - 10),
        targetX: null, targetY: null,
        hp: def.hp, maxHp: def.maxHp, state: "idle", cargo: 0,
        attackTargetId: null, attackCooldownLeft: 0, attackMoveMode: false,
        attackMoveHomeX: null, attackMoveHomeY: null, // ИИ №24: см. CHASE_LEASH_RADIUS выше
      };
      b.buildQueue.shift();
      if (b.ownerId === localPlayerId) logMsg(`Готово: ${def.label}`);
    }
  });
}

function updatePowerAndUnitCounts() {
  Object.values(State.players).forEach(p => {
    let power = 0, use = 0;
    Object.values(State.buildings).filter(b => b.ownerId === p.id).forEach(b => {
      const def = BuildingDefs[b.type];
      if (def) { power += def.producesPower || 0; use += def.powerUse || 0; }
    });
    // ИИ №21: лог-предупреждение игроку при ПЕРЕХОДЕ в дефицит (не каждый
    // тик, пока дефицит длится, — иначе лог мгновенно забился бы) — тот же
    // паттерн, что уже применяется у ИИ (enemyFsm логирует смену фазы один
    // раз, а не на каждый decision-тик).
    const wasDeficit = p.powerDeficit === true;
    const isDeficit = use > power;
    if (p.id === localPlayerId && isDeficit && !wasDeficit) {
      logMsg("Дефицит питания — производство юнитов замедлено, постройте электростанцию", "warn");
    }
    p.powerDeficit = isDeficit;
    p.power = power; p.powerUse = use;
  });
}
