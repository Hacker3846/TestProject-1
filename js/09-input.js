/* ---------------------------- Ввод: выделение, движение, добыча ---------------------------- */

let dragStart = null;
const selBox = document.getElementById("selectionBox");

viewport.addEventListener("mousedown", (e) => {
  // ИИ №4: в режиме размещения здания ЛКМ подтверждает постройку вместо
  // того чтобы начинать рамку выделения.
  if (State.buildMode) {
    if (e.button === 0) confirmBuildPlacement();
    return;
  }
  if (e.button !== 0) return; // ЛКМ — только выделение
  dragStart = { x: e.clientX, y: e.clientY };
  selBox.style.display = "block";
  selBox.style.left = e.clientX + "px";
  selBox.style.top = e.clientY + "px";
  selBox.style.width = "0px";
  selBox.style.height = "0px";
});

viewport.addEventListener("mousemove", (e) => {
  // ИИ №4: пока активен режим размещения — обновляем мировую позицию
  // призрака и пересчитываем валидность на каждое движение мыши.
  if (State.buildMode) {
    const rect = viewport.getBoundingClientRect();
    const world = screenToWorldZoomed(e.clientX - rect.left, e.clientY - rect.top);
    // ИИ (по прямому запросу пользователя, "здания ставятся строго в
    // клетки"): призрак здания привязывается к тайловой сетке карты для
    // ЛЮБОГО типа, кроме wall — у стен своя отдельная, более старая
    // система привязки (snapWallPointToGrid/буквальная постройка по клику,
    // см. 18-walls.js, которая перехватывает mousedown в capture-фазе и
    // строит стену САМА, эта функция для wall лишь двигает декоративный
    // одиночный призрак — не мешаем, просто не снапаем его здесь).
    const snapped = (State.buildMode.type !== "wall")
      ? snapBuildingCenterToGrid(State.buildMode.type, world.x, world.y)
      : world;
    State.buildGhostWorld.x = snapped.x;
    State.buildGhostWorld.y = snapped.y;
    State.buildMode.valid = isBuildPlacementValid(State.buildMode.type, snapped.x, snapped.y);
  }
  if (!dragStart) return;
  const x1 = Math.min(dragStart.x, e.clientX);
  const y1 = Math.min(dragStart.y, e.clientY);
  const w = Math.abs(e.clientX - dragStart.x);
  const h = Math.abs(e.clientY - dragStart.y);
  selBox.style.left = x1 + "px";
  selBox.style.top = y1 + "px";
  selBox.style.width = w + "px";
  selBox.style.height = h + "px";
});

window.addEventListener("mouseup", (e) => {
  if (!dragStart) return;
  const rect = viewport.getBoundingClientRect();
  const x1 = Math.min(dragStart.x, e.clientX) - rect.left;
  const y1 = Math.min(dragStart.y, e.clientY) - rect.top;
  const x2 = Math.max(dragStart.x, e.clientX) - rect.left;
  const y2 = Math.max(dragStart.y, e.clientY) - rect.top;

  State.selection.clear();
  Object.values(State.units).forEach(u => {
    if (u.ownerId !== localPlayerId) return;
    const s = worldToScreenZoomed(u.x, u.y);
    if (s.x >= x1 && s.x <= x2 && s.y >= y1 && s.y <= y2) {
      State.selection.add(u.id);
    }
  });

  // Если рамка была почти точкой (обычный клик) — попробовать выбрать здание тоже
  if (x2 - x1 < 4 && y2 - y1 < 4) {
    Object.values(State.buildings).forEach(b => {
      if (b.ownerId !== localPlayerId) return;
      const s = worldToScreenZoomed(b.x, b.y);
      const def = BuildingDefs[b.type];
      const w2 = def.w * GameConfig.tileSize, h2 = def.h * GameConfig.tileSize;
      if (x1 >= s.x - w2/2 && x1 <= s.x + w2/2 && y1 >= s.y - h2/2 && y1 <= s.y + h2/2) {
        State.selection.add(b.id);
      }
    });
  }

  dragStart = null;
  selBox.style.display = "none";
  renderSelectionPanel();
});

viewport.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  // ИИ №4: ПКМ в режиме размещения — отмена режима, а не обычный
  // приказ движения/атаки/добычи.
  if (State.buildMode) {
    cancelBuildMode();
    logMsg("Размещение отменено");
    return;
  }
  const rect = viewport.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  const world = screenToWorldZoomed(sx, sy);

  // Если кликнули по ресурсу — рабочие идут добывать
  const clickedNode = Object.values(State.resources).find(r => dist(r.x, r.y, world.x, world.y) < 16);

  // ИИ №3: если кликнули по ВРАЖЕСКОМУ юниту или зданию — это приказ
  // "атаковать цель", а не просто идти в точку. Радиус клика по юниту
  // чуть больше, чем радиус его отрисовки (7px), чтобы было проще попасть.
  // ИИ №6: дополнительно — цель должна быть сейчас РЕАЛЬНО ВИДИМА (фог
  // войны), иначе игрок мог бы кликать "вслепую" по координатам, где по
  // случаю/памяти знает вражеский юнит, хотя на экране там просто туман.
  let clickedEnemy = Object.values(State.units).find(
    u => u.ownerId !== localPlayerId
      && dist(u.x, u.y, world.x, world.y) < 14
      && isWorldPointVisible(u.x, u.y)
  );
  if (!clickedEnemy) {
    clickedEnemy = Object.values(State.buildings).find(b => {
      if (b.ownerId === localPlayerId) return false;
      // ИИ №46 (по прямому запросу пользователя: "стен вообще будто и нету
      // пока 1 секунда не пройдёт") — призрачную стену нельзя выбрать
      // явным кликом для приказа "атаковать" — она физически ещё не
      // существует для боевой логики (см. те же исключения в
      // findNearestEnemyInRange/findAttackableAt, 07-game-loop-combat.js).
      if (b.type === "wall" && b.constructionMsLeft > 0) return false;
      if (!isWorldPointVisible(b.x, b.y)) return false;
      const def = BuildingDefs[b.type];
      const halfW = def.w * GameConfig.tileSize / 2, halfH = def.h * GameConfig.tileSize / 2;
      return Math.abs(world.x - b.x) <= halfW && Math.abs(world.y - b.y) <= halfH;
    });
  }

  let anyoneMoved = false;
  let anyoneAttacked = false;
  State.selection.forEach(id => {
    const u = State.units[id];
    if (!u || u.ownerId !== localPlayerId) return;
    const def = UnitDefs[u.type];

    if (clickedEnemy && def.canAttack) {
      // Явный приказ атаки — сбрасывает attack-move, ставит конкретную цель
      u.attackTargetId = clickedEnemy.id;
      u.attackMoveMode = false;
      setUnitDestination(u, clickedEnemy.x, clickedEnemy.y);
      u.state = "moving";
      anyoneAttacked = true;
    } else if (clickedNode && u.type === "worker") {
      u.harvestTargetId = clickedNode.id;
      u.state = "moving-to-harvest";
      setUnitDestination(u, clickedNode.x, clickedNode.y);
    } else {
      // ИИ №26: БАГФИКС "юниты забредают на вражескую базу" (репорт
      // пользователя). Раньше attackMoveMode ставился ТОЛЬКО при
      // Shift+ПКМ — обычный move-приказ шёл с attackMoveMode=false, из-за
      // чего leash CHASE_LEASH_RADIUS (см. 07-game-loop-combat.js) вообще
      // не активировался: юнит доходил до точки, вставал в state==="idle"
      // БЕЗ attackMoveHomeX/Y, дальше updateCombat подхватывал его
      // автопоиском (условие `state==="idle" || attackMoveMode` —idle само
      // по себе уже достаточно) и юнит гнался за замеченным врагом без
      // всякого ограничения дальности, вплоть до вражеской базы.
      // Теперь ЛЮБОЙ move-приказ боевого юнита (Shift или нет) всегда
      // включает attackMoveMode и фиксирует attackMoveHomeX/Y на точку
      // приказа — юнит и атакует на ходу (см. отдельный фикс автопоиска
      // "во время движения" в updateCombat, 07), и не убегает от этой
      // точки дальше CHASE_LEASH_RADIUS. Shift+ПКМ/long-press теперь просто
      // синоним обычного приказа для боевых юнитов (семантика не
      // потеряна — оставлен как явный способ дать тот же эффект).
      u.attackTargetId = null;
      u.attackMoveMode = def.canAttack;
      setUnitDestination(u, world.x, world.y);
      if (u.attackMoveMode) { u.attackMoveHomeX = world.x; u.attackMoveHomeY = world.y; } // ИИ №24/№26: точка для CHASE_LEASH_RADIUS (07)
      u.state = "moving";
    }
    anyoneMoved = true;
  });
  if (anyoneAttacked) logMsg("Отряд атакует цель", "warn");
  else if (anyoneMoved) logMsg(clickedNode ? "Отряд направлен на добычу ресурсов" : "Отряд движется к цели");
});

/* ================================================================
   МОБИЛЬНОЕ ТАЧ-УПРАВЛЕНИЕ
   Не трогает ни одной строки логики выше — переиспользует те же функции
   (setUnitDestination, confirmBuildPlacement, isBuildPlacementValid и
   т.д.), просто даёт touch-эквиваленты мышиных жестов:
     - один палец, тап по юниту/зданию              -> выделение (= ЛКМ-клик)
     - один палец, тап по пустому месту с выделением -> движение/атака/добыча (= ПКМ)
     - один палец, drag                              -> панорамирование камеры
     - один палец, долгое удержание (>420мс) на месте
       + есть выделение боевых юнитов                -> attack-move в точку (= Shift+ПКМ)
     - два пальца, drag                               -> рамка выделения (замена мышиной
       рамки, которая на одном пальце конфликтовала бы с панорамой)
     - режим размещения здания: тап подтверждает (= ЛКМ), кнопка "Отмена"
       не нужна отдельно — есть ПКМ-эквивалент через долгий тап вне режима
       через cancelBuildMode при тапе вторым пальцем.
   Работает через #touchPanZone — прозрачный слой поверх канваса (только
   когда виден по мобильному media query), чтобы не мешать обычным mouse-
   обработчикам того же viewport на десктопе.
   ================================================================ */
(function setupTouchControls() {
  const panZone = document.getElementById("touchPanZone");
  if (!panZone) return;

  const TAP_MAX_MOVE = 12;      // px — сколько можно сдвинуть палец, чтобы это всё ещё считалось тапом
  const LONG_PRESS_MS = 420;
  const DOUBLE_TAP_MS = 300;

  let touchMode = null;         // null | 'pending' | 'pan' | 'box-select'
  let touchStart = null;        // {x,y,t}
  let lastMoveTouch = null;     // для дельты панорамирования
  let longPressTimer = null;
  let longPressFired = false;
  let lastTapTime = 0;
  let lastTapPos = null;

  function clearLongPressTimer() {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  }

  function rectOf() { return viewport.getBoundingClientRect(); }

  // Находит ближайший ко клику юнит/здание игрока (для выделения тапом) —
  // логика идентична mouseup-обработчику выше, но как отдельная функция,
  // чтобы не дублировать поиск инлайн.
  function selectAtScreenPoint(sx, sy, additive) {
    let hitId = null;
    let bestD = 20; // немного щедрее мышиного клика — палец толще курсора
    Object.values(State.units).forEach(u => {
      if (u.ownerId !== localPlayerId) return;
      const s = worldToScreenZoomed(u.x, u.y);
      const d = dist(s.x, s.y, sx, sy);
      if (d < bestD) { bestD = d; hitId = u.id; }
    });
    if (!hitId) {
      Object.values(State.buildings).forEach(b => {
        if (b.ownerId !== localPlayerId) return;
        const s = worldToScreenZoomed(b.x, b.y);
        const def = BuildingDefs[b.type];
        const w2 = def.w * GameConfig.tileSize, h2 = def.h * GameConfig.tileSize;
        if (Math.abs(sx - s.x) <= w2 / 2 + 8 && Math.abs(sy - s.y) <= h2 / 2 + 8) hitId = b.id;
      });
    }
    if (!additive) State.selection.clear();
    if (hitId) State.selection.add(hitId);
    renderSelectionPanel();
    return hitId;
  }

  // Отдаёт приказ (движение/атака/добыча) выделенным юнитам к мировой
  // точке — та же ветка решений, что и в contextmenu-обработчике мыши.
  function issueOrderAtWorldPoint(world, attackMove) {
    const clickedNode = Object.values(State.resources).find(r => dist(r.x, r.y, world.x, world.y) < 20);
    let clickedEnemy = Object.values(State.units).find(
      u => u.ownerId !== localPlayerId && dist(u.x, u.y, world.x, world.y) < 18 && isWorldPointVisible(u.x, u.y)
    );
    if (!clickedEnemy) {
      clickedEnemy = Object.values(State.buildings).find(b => {
        if (b.ownerId === localPlayerId) return false;
        // ИИ №46: та же защита от выбора призрачной стены, что и в
        // обработчике мыши выше в этом файле.
        if (b.type === "wall" && b.constructionMsLeft > 0) return false;
        if (!isWorldPointVisible(b.x, b.y)) return false;
        const def = BuildingDefs[b.type];
        const halfW = def.w * GameConfig.tileSize / 2, halfH = def.h * GameConfig.tileSize / 2;
        return Math.abs(world.x - b.x) <= halfW && Math.abs(world.y - b.y) <= halfH;
      });
    }

    let anyoneMoved = false, anyoneAttacked = false;
    State.selection.forEach(id => {
      const u = State.units[id];
      if (!u || u.ownerId !== localPlayerId) return;
      const def = UnitDefs[u.type];
      if (clickedEnemy && def.canAttack) {
        u.attackTargetId = clickedEnemy.id;
        u.attackMoveMode = false;
        setUnitDestination(u, clickedEnemy.x, clickedEnemy.y);
        u.state = "moving";
        anyoneAttacked = true;
      } else if (clickedNode && u.type === "worker") {
        u.harvestTargetId = clickedNode.id;
        u.state = "moving-to-harvest";
        setUnitDestination(u, clickedNode.x, clickedNode.y);
      } else {
        // ИИ №26: тот же фикс, что и в мышином обработчике выше (см. его
        // подробный комментарий) — обычный тап-приказ тоже всегда
        // включает attackMoveMode/attackMoveHomeX/Y для боевых юнитов, не
        // только long-press. attackMove-параметр (long-press) больше не
        // меняет исход для боевых юнитов — оставлен только для лога ниже.
        u.attackTargetId = null;
        u.attackMoveMode = def.canAttack;
        setUnitDestination(u, world.x, world.y);
        if (u.attackMoveMode) { u.attackMoveHomeX = world.x; u.attackMoveHomeY = world.y; } // ИИ №24/№26
        u.state = "moving";
      }
      anyoneMoved = true;
    });
    if (anyoneAttacked) logMsg("Отряд атакует цель", "warn");
    else if (anyoneMoved) logMsg(clickedNode ? "Отряд направлен на добычу ресурсов" : (attackMove ? "Атака-движение к точке" : "Отряд движется к цели"));
    return anyoneMoved || anyoneAttacked;
  }

  panZone.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2 && State.buildMode) {
      // Второй палец во время размещения здания = отмена (аналог ПКМ/Esc).
      clearLongPressTimer();
      cancelBuildMode();
      logMsg("Размещение отменено");
      touchMode = null; touchStart = null;
      e.preventDefault();
      return;
    }
    if (e.touches.length === 2) {
      // Второй палец — переключаемся в режим рамки выделения от текущей
      // средней точки; отменяем любой начатый long-press одиночного тапа.
      clearLongPressTimer();
      touchMode = "box-select";
      const rect = rectOf();
      const t0 = e.touches[0], t1 = e.touches[1];
      const mx = (t0.clientX + t1.clientX) / 2 - rect.left;
      const my = (t0.clientY + t1.clientY) / 2 - rect.top;
      touchStart = { x: mx, y: my, t: Date.now() };
      selBox.style.display = "block";
      selBox.style.left = (mx + rect.left) + "px";
      selBox.style.top = (my + rect.top) + "px";
      selBox.style.width = "0px";
      selBox.style.height = "0px";
      e.preventDefault();
      return;
    }
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    const rect = rectOf();
    touchStart = { x: touch.clientX - rect.left, y: touch.clientY - rect.top, t: Date.now() };
    lastMoveTouch = { x: touch.clientX, y: touch.clientY };
    touchMode = "pending";
    longPressFired = false;

    // В режиме размещения здания тап сразу подтверждает — не ждём отпускания.
    // ИИ (по прямому запросу пользователя, "здания ставятся строго в
    // клетки"): раньше здесь просто return — ghost-позиция (buildGhostWorld)
    // на тач-устройствах вообще не обновлялась от touchmove (в отличие от
    // мыши, см. mousemove выше), поэтому confirmBuildPlacement() ниже по
    // touchend строил бы здание в СТАРОЙ/дефолтной точке, а не там, где
    // реально тапнул игрок. Считаем мировую точку прямо из самого тапа и
    // снапаем её на сетку — тем же путём, что и mousemove (см. выше),
    // включая исключение для wall (у стен свой обработчик, см. 18-walls.js).
    if (State.buildMode) {
      const world = screenToWorldZoomed(touchStart.x, touchStart.y);
      const snapped = (State.buildMode.type !== "wall")
        ? snapBuildingCenterToGrid(State.buildMode.type, world.x, world.y)
        : world;
      State.buildGhostWorld.x = snapped.x;
      State.buildGhostWorld.y = snapped.y;
      State.buildMode.valid = isBuildPlacementValid(State.buildMode.type, snapped.x, snapped.y);
      return;
    }

    clearLongPressTimer();
    longPressTimer = setTimeout(() => {
      if (touchMode !== "pending") return; // палец уже успел стать панорамой
      longPressFired = true;
      const world = screenToWorldZoomed(touchStart.x, touchStart.y);
      if (State.selection.size > 0) {
        issueOrderAtWorldPoint(world, true); // long-press = attack-move
      }
    }, LONG_PRESS_MS);
  }, { passive: false });

  panZone.addEventListener("touchmove", (e) => {
    if (touchMode === "box-select" && e.touches.length >= 1) {
      const rect = rectOf();
      const touch = e.touches[e.touches.length - 1];
      const cx = touch.clientX - rect.left, cy = touch.clientY - rect.top;
      const x1 = Math.min(touchStart.x, cx), y1 = Math.min(touchStart.y, cy);
      const w = Math.abs(cx - touchStart.x), h = Math.abs(cy - touchStart.y);
      selBox.style.left = (x1 + rect.left) + "px";
      selBox.style.top = (y1 + rect.top) + "px";
      selBox.style.width = w + "px";
      selBox.style.height = h + "px";
      e.preventDefault();
      return;
    }
    if (e.touches.length !== 1 || !touchStart) return;
    const touch = e.touches[0];
    const rect = rectOf();
    const sx = touch.clientX - rect.left, sy = touch.clientY - rect.top;
    const movedDist = dist(sx, sy, touchStart.x, touchStart.y);

    if (touchMode === "pending" && movedDist > TAP_MAX_MOVE) {
      // Палец пополз достаточно далеко — это панорамирование, а не тап.
      touchMode = "pan";
      clearLongPressTimer();
    }
    if (touchMode === "pan") {
      const dx = touch.clientX - lastMoveTouch.x;
      const dy = touch.clientY - lastMoveTouch.y;
      // ИИ (зум камеры): dx/dy — это дельта в РЕАЛЬНЫХ экранных пикселях
      // (палец на экране), а camera.x/y — мировые координаты. При zoom≠1
      // экранный пиксель "стоит" не одну мировую единицу, а 1/zoom — без
      // деления на zoom панорама на приближённой карте улетала бы быстрее
      // движения пальца, а на отдалённой — медленнее.
      State.camera.x -= dx / State.camera.zoom;
      State.camera.y -= dy / State.camera.zoom;
      lastMoveTouch = { x: touch.clientX, y: touch.clientY };
    }
    e.preventDefault();
  }, { passive: false });

  panZone.addEventListener("touchend", (e) => {
    clearLongPressTimer();
    const rect = rectOf();

    if (touchMode === "box-select") {
      // Рамка выделения (двухпальцевый жест) — завершаем как мышиную рамку.
      const lastLeft = parseFloat(selBox.style.left) - rect.left;
      const lastTop = parseFloat(selBox.style.top) - rect.top;
      const w = parseFloat(selBox.style.width) || 0;
      const h = parseFloat(selBox.style.height) || 0;
      const x1 = lastLeft, y1 = lastTop, x2 = lastLeft + w, y2 = lastTop + h;
      State.selection.clear();
      Object.values(State.units).forEach(u => {
        if (u.ownerId !== localPlayerId) return;
        const s = worldToScreenZoomed(u.x, u.y);
        if (s.x >= x1 && s.x <= x2 && s.y >= y1 && s.y <= y2) State.selection.add(u.id);
      });
      selBox.style.display = "none";
      renderSelectionPanel();
      touchMode = null; touchStart = null;
      return;
    }

    if (!touchStart) return;

    if (State.buildMode) {
      // Тап в режиме размещения — подтверждаем постройку (как ЛКМ).
      confirmBuildPlacement();
      touchMode = null; touchStart = null;
      return;
    }

    if (touchMode === "pending" && !longPressFired) {
      const now = Date.now();
      const isDoubleTap = lastTapPos && (now - lastTapTime) < DOUBLE_TAP_MS && dist(lastTapPos.x, lastTapPos.y, touchStart.x, touchStart.y) < 24;
      lastTapTime = now; lastTapPos = { x: touchStart.x, y: touchStart.y };

      if (State.selection.size > 0) {
        // Если тап попал по своему юниту/зданию — переключаем выделение
        // на него; иначе трактуем как приказ (движение/атака/добыча).
        const hitOwn = Object.values(State.units).some(u => u.ownerId === localPlayerId && dist(worldToScreenZoomed(u.x, u.y).x, worldToScreenZoomed(u.x, u.y).y, touchStart.x, touchStart.y) < 20)
          || Object.values(State.buildings).some(b => {
            if (b.ownerId !== localPlayerId) return false;
            const s = worldToScreenZoomed(b.x, b.y);
            const def = BuildingDefs[b.type];
            const w2 = def.w * GameConfig.tileSize, h2 = def.h * GameConfig.tileSize;
            return Math.abs(touchStart.x - s.x) <= w2 / 2 + 8 && Math.abs(touchStart.y - s.y) <= h2 / 2 + 8;
          });
        if (hitOwn) {
          selectAtScreenPoint(touchStart.x, touchStart.y, false);
        } else {
          const world = screenToWorldZoomed(touchStart.x, touchStart.y);
          issueOrderAtWorldPoint(world, false);
        }
      } else {
        selectAtScreenPoint(touchStart.x, touchStart.y, false);
      }
    }

    touchMode = null; touchStart = null;
  });

  panZone.addEventListener("touchcancel", () => {
    clearLongPressTimer();
    touchMode = null; touchStart = null;
    selBox.style.display = "none";
  });

  // Кнопки мобильной панели действий (см. game.html #mobileActionBar).
  const selPanelBtn = document.getElementById("mobileSelPanelBtn");
  const centerBtn = document.getElementById("mobileCenterBtn");
  const selPanelEl = document.getElementById("selPanel");
  if (selPanelBtn && selPanelEl) {
    selPanelBtn.addEventListener("click", () => {
      selPanelEl.classList.toggle("open");
    });
  }
  if (centerBtn) {
    centerBtn.addEventListener("click", () => {
      // Штаб приоритетно, иначе любое своё здание — чтобы кнопка не была
      // бесполезной в редком случае, если штаб почему-то уже уничтожен.
      const hq = Object.values(State.buildings).find(b => b.ownerId === localPlayerId && b.type === "commandCenter")
        || Object.values(State.buildings).find(b => b.ownerId === localPlayerId);
      if (hq) {
        // ИИ (зум камеры): половина ВИДИМОЙ (с учётом текущего zoom)
        // области, а не половина canvas.logicalWidth напрямую — иначе на
        // приближённой карте штаб оказывался бы не по центру экрана.
        State.camera.x = hq.x - visibleWorldWidth() / 2;
        State.camera.y = hq.y - visibleWorldHeight() / 2;
      }
    });
  }
})();

/* ================================================================
   ЗУМ КАМЕРЫ (кнопки +/- в панели ВЫДЕЛЕНИЕ, game.html #zoomInBtn/
   #zoomOutBtn — по прямому запросу пользователя). Диапазон ограничен
   GameConfig.zoomMin..zoomMax (см. 01-config-state.js), т.е. зум НЕ
   бесконечный, как и было явно попрошено.
   ================================================================ */
// Общая точка входа для любого способа зума (кнопки, колесо мыши) —
// одна и та же функция клэмпит диапазон, поэтому новый способ зума
// (если появится) не сможет случайно вылезти за zoomMin/zoomMax.
function applyZoomDelta(delta, pivotScreenX, pivotScreenY) {
  const cam = State.camera;
  const oldZoom = cam.zoom;
  // Math.round(...*100)/100: без этого повторные клики по +/- копят
  // погрешность плавающей точки (0.1+0.1+0.1 !== 0.3 в JS) — итоговый
  // zoom постепенно "уплывал" бы от круглых значений шага. Клэмп по
  // границам работал бы и без этого (Math.min/max нечувствителен к
  // микропогрешности), но сравнение newZoom === oldZoom ниже и просто
  // чистота итогового числа в State от округления только выигрывают.
  const rawZoom = Math.round((oldZoom + delta) * 100) / 100;
  const newZoom = Math.min(GameConfig.zoomMax, Math.max(GameConfig.zoomMin, rawZoom));
  if (newZoom === oldZoom) return;

  // Если задана точка-опора (курсор мыши) — держим мировую точку под
  // курсором неподвижной при зуме (стандартное поведение "зум к курсору"),
  // а не просто зумим от левого верхнего угла камеры. Для кнопок +/- и
  // мобильных устройств pivot не передаётся — зумим от центра экрана.
  const px = pivotScreenX != null ? pivotScreenX : canvas.logicalWidth / 2;
  const py = pivotScreenY != null ? pivotScreenY : canvas.logicalHeight / 2;
  const worldAtPivot = { x: px / oldZoom + cam.x, y: py / oldZoom + cam.y };

  cam.zoom = newZoom;
  cam.x = worldAtPivot.x - px / newZoom;
  cam.y = worldAtPivot.y - py / newZoom;
}

const zoomInBtn = document.getElementById("zoomInBtn");
const zoomOutBtn = document.getElementById("zoomOutBtn");
if (zoomInBtn) zoomInBtn.addEventListener("click", () => applyZoomDelta(GameConfig.zoomStep));
if (zoomOutBtn) zoomOutBtn.addEventListener("click", () => applyZoomDelta(-GameConfig.zoomStep));

// Бонус: зум колесом мыши прямо над картой, к точке под курсором — на
// десктопе это ожидаемо для RTS-камеры и ничего не ломает в остальном
// вводе (сама рамка выделения/приказы работают через mousedown/click,
// колесо с ними не пересекается).
viewport.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = viewport.getBoundingClientRect();
  const delta = e.deltaY < 0 ? GameConfig.zoomStep : -GameConfig.zoomStep;
  applyZoomDelta(delta, e.clientX - rect.left, e.clientY - rect.top);
}, { passive: false });

// Прокрутка карты стрелками/WASD
const keysDown = {};
window.addEventListener("keydown", (e) => {
  keysDown[e.key.toLowerCase()] = true;
  // ИИ №4: Escape отменяет режим размещения здания, если он активен.
  if (e.key === "Escape" && State.buildMode) {
    cancelBuildMode();
    logMsg("Размещение отменено");
  }
});
window.addEventListener("keyup", (e) => { keysDown[e.key.toLowerCase()] = false; });
setInterval(() => {
  const camSpeed = 12;
  if (keysDown["w"] || keysDown["arrowup"]) State.camera.y -= camSpeed;
  if (keysDown["s"] || keysDown["arrowdown"]) State.camera.y += camSpeed;
  if (keysDown["a"] || keysDown["arrowleft"]) State.camera.x -= camSpeed;
  if (keysDown["d"] || keysDown["arrowright"]) State.camera.x += camSpeed;
}, 16);
