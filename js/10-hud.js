/* ---------------------------- HUD: постройка, панели ---------------------------- */

// ИИ №30: интерфейс постройки/найма разделён на 3 категории по прямому
// запросу пользователя ("разделить на 3 кнопки которые ведут к 3
// классам: техника, здания, юниты(боец)") — раньше (ИИ №28,
// 16-tech-unlock.js) было 2 секции: "Постройки" + общий список "Юниты"
// вперемешку (пехота и техника одной кучей). Теперь юниты дополнительно
// делятся на пехоту и технику, отдельная категория "Здания" остаётся
// как есть. Категория юнита определяется через unitCategoryOf() ниже —
// явный список ключей техники + fallback на пехоту, а не поле в
// UnitDefs (01-config-state.js не трогаем без явного запроса).
//
// Три кнопки-категории (#buildBarTabs, разметка в game.html): на
// десктопе не переключают видимость секций — все 3 секции построек/
// юнитов видны одновременно, кнопки лишь прокручивают #buildBar к
// нужной секции. На телефоне (ИИ №31, отдельное решение из-за жалобы
// "панель закрывает обзор") — наоборот, настоящий переключатель:
// видна только одна категория за раз. Подробности см. в комментарии
// над setupBuildBarTabs() ниже.
//
// ИИ №30: логика блокировки юнитов по зданиям (ранее жила отдельным
// патч-модулем 16-tech-unlock.js, оборачивающим buildBuildBar ПОСЛЕ его
// объявления) перенесена сюда, в сам buildBuildBar — по прямому решению
// пользователя переписать эту функцию напрямую, а не добавлять ещё один
// патч-слой поверх неё. Патчинг buildBuildBar в 16-tech-unlock.js
// отключён (см. футер этого файла) — иначе он затёр бы категории
// техники/пехоты обратно в одну секцию "Юниты".

// Явный список ключей техники — всё, что не в этом списке, считается
// пехотой (устраивает текущий состав UnitDefs: rifleman/rocketeer/
// grenadier/sniper/sapper — пехота; tank/heavyTank/apc/aircraft/gunship/
// artillery — техника).
// Новый юнит-техника добавляется сюда одной строкой; про юнита-пехоту
// можно вообще не вспоминать (дефолт).
// ИИ №34: добавлены gunship (второй летающий юнит) и artillery (САУ) —
// sapper НЕ добавлен (пехота, попадает в фолбэк-ветку "infantry" сама).
const VEHICLE_UNIT_KEYS = ["tank", "heavyTank", "apc", "aircraft", "gunship", "artillery"];
function unitCategoryOf(key) {
  return VEHICLE_UNIT_KEYS.includes(key) ? "vehicle" : "infantry";
}

// Здание считается "источником" юнита, если оно живое (hp>0) и
// принадлежит локальному игроку. Логика перенесена из 16-tech-unlock.js
// (ИИ №28) без изменений — просто сменила файл при слиянии категорий
// техники/пехоты в сам buildBuildBar (ИИ №30).
function unlockedProducerBuildingKeys(unitKey) {
  const keys = [];
  Object.entries(BuildingDefs).forEach(([bKey, bDef]) => {
    if (bDef.produces && bDef.produces.includes(unitKey)) keys.push(bKey);
  });
  return keys;
}

// Возвращает { unlocked, requiredLabel } — подробности см. в футере
// 16-tech-unlock.js (перенесено без изменений логики).
function unitUnlockStatus(unitKey) {
  const producerKeys = unlockedProducerBuildingKeys(unitKey);
  if (producerKeys.length === 0) return { unlocked: true, requiredLabel: null };

  const hasProducer = Object.values(State.buildings).some(b => {
    if (b.ownerId !== localPlayerId || b.hp <= 0) return false;
    return producerKeys.includes(b.type);
  });

  if (hasProducer) return { unlocked: true, requiredLabel: null };

  const label = BuildingDefs[producerKeys[0]] ? BuildingDefs[producerKeys[0]].label : producerKeys[0];
  return { unlocked: false, requiredLabel: label };
}

// Простые эмодзи-глифы кнопок (перенесены из 16-tech-unlock.js, ИИ №28/29,
// без изменений).
function buildingIconGlyph(key) {
  const glyphs = {
    powerPlant: "⚡", barracks: "🎖", turret: "🗼", warFactory: "⚙",
    airfield: "✈",
  };
  return glyphs[key] || "🏗";
}
function unitIconGlyph(key) {
  const glyphs = {
    rifleman: "🎯", rocketeer: "💥", tank: "🛡",
    aircraft: "✈", grenadier: "☢", heavyTank: "🚜", sniper: "🔭", apc: "🚚",
    // ИИ №34: новые юниты — вертолёт/сапёр/самоходка
    gunship: "🚁", sapper: "🧨", artillery: "💣",
  };
  return glyphs[key] || "●";
}

// Создаёт одну секцию (заголовок + ряд кнопок) внутри #buildBar и
// возвращает контейнер-ряд (.buildBarSectionRow), куда вызывающий код
// добавляет сами кнопки. sectionId нужен для scrollIntoView по клику на
// кнопку-категорию (#buildBarTabs, см. setupBuildBarTabs).
function makeBuildBarSection(bar, sectionId, labelText) {
  const section = document.createElement("div");
  section.className = "buildBarSection";
  section.id = sectionId;
  const label = document.createElement("div");
  label.className = "buildBarSectionLabel";
  label.textContent = labelText;
  section.appendChild(label);
  const row = document.createElement("div");
  row.className = "buildBarSectionRow";
  section.appendChild(row);
  bar.appendChild(section);
  return row;
}

function buildBuildBar() {
  const bar = document.getElementById("buildBar");
  bar.innerHTML = "";

  const buildRow = makeBuildBarSection(bar, "buildBarSectionBuildings", "Здания");
  // ИИ №35: цена на кнопке — через getBuildingCost() (01-config-state.js),
  // а не def.cost напрямую, т.к. у refinery цена растёт с каждой
  // построенной станцией (см. комментарий там же). Текст на кнопке,
  // выставленный здесь, актуален только в момент сборки ленты — далее его
  // держит в актуальном состоянии refreshBuildBarPrices() (ниже),
  // вызываемая каждый тик из renderHUD().
  const barPlayer = State.players[localPlayerId];
  Object.entries(BuildingDefs).forEach(([key, def]) => {
    if (key === "commandCenter") return; // штаб выдаётся один раз при старте, вручную не строится
    const btn = document.createElement("button");
    btn.className = "buildBtn";
    btn.dataset.buildKey = key;
    btn.dataset.category = "building";
    btn.innerHTML = `<span class="buildBtnIcon">${buildingIconGlyph(key)}</span>
      <span class="buildBtnLabel">${def.label}</span>
      <small>${getBuildingCost(key, barPlayer)} кр.</small>`;
    btn.onclick = () => tryStartBuilding(key);
    buildRow.appendChild(btn);
  });

  const vehicleRow = makeBuildBarSection(bar, "buildBarSectionVehicles", "Техника");
  const infantryRow = makeBuildBarSection(bar, "buildBarSectionInfantry", "Юниты (бойцы)");

  Object.entries(UnitDefs).forEach(([key, def]) => {
    const isVehicle = unitCategoryOf(key) === "vehicle";
    const targetRow = isVehicle ? vehicleRow : infantryRow;
    const btn = document.createElement("button");
    btn.className = "buildBtn unitBtn";
    btn.dataset.unitKey = key;
    btn.dataset.category = isVehicle ? "vehicle" : "infantry";
    btn.innerHTML = `<span class="buildBtnIcon">${unitIconGlyph(key)}</span>
      <span class="buildBtnLabel">${def.label}</span>
      <small>${def.cost} кр.</small>
      <span class="lockOverlay">🔒<em></em></span>`;
    btn.onclick = () => {
      const status = unitUnlockStatus(key);
      if (!status.unlocked) {
        logMsg(`Недоступно: ${def.label} — требуется здание «${status.requiredLabel}»`, "warn");
        return;
      }
      tryTrainUnit(key);
    };
    targetRow.appendChild(btn);
  });

  refreshUnitLockState();
  refreshBuildBarActiveState();
  // ИИ №30/№31: вызываем ПОСЛЕ создания секций выше (setActiveSection
  // внутри обращается к #buildBarSectionBuildings и т.д. по id — до
  // этого момента их ещё нет в DOM). Разметка #buildBarTabs сама по себе
  // статична, но buildBuildBar() перестраивает #buildBar целиком (innerHTML
  // = ""), поэтому секции — новые DOM-узлы каждый вызов, и мобильное
  // активное состояние нужно выставлять заново. Вызываем отсюда, а не из
  // 13-bootstrap.js (который мне не присылали), чтобы не зависеть от
  // правки файла, которого нет в моём контексте.
  setupBuildBarTabs();
}

// ИИ №31: по прямому решению пользователя поведение вкладок теперь
// РАЗНОЕ на десктопе и телефоне (раньше — везде только scrollIntoView):
//  - десктоп (ширина > 820px, тот же брейкпоинт что и остальной мобильный
//    layout в game.html): все 3 секции по-прежнему видны одновременно,
//    вкладка лишь прокручивает к своей секции — там места достаточно, и
//    настоящий toggle с скрытием только заставлял бы лишний раз кликать,
//    ничего не выигрывая по пространству.
//  - телефон: показывается ОДНА категория за раз (класс
//    "mobileTabActive" на секции, "tabSelected" на активной вкладке) —
//    освобождает вертикаль, которой на телефоне не хватает (жалоба
//    "панель закрывает обзор").
// MOBILE_TABS_QUERY зеркалит медиа-запрос из <style> game.html
// (@media max-width:820px, ...) — если брейкпоинт там изменится, стоит
// поправить и здесь, иначе поведение JS и CSS разъедутся.
const MOBILE_TABS_QUERY = "(max-width:820px), (max-height:520px) and (orientation:landscape)";

// Кнопки-категории над панелью (#buildBarTabs, разметка в game.html).
// Вызывается из buildBuildBar() при каждой перестройке ленты — сами
// кнопки статичны, поэтому повторный вызов лишь идемпотентно
// переставляет .onclick и текущее активное состояние.
function setupBuildBarTabs() {
  const tabs = document.getElementById("buildBarTabs");
  if (!tabs) return; // разметки нет в game.html — не ломаем игру, категории всё равно видны в самом buildBar
  const targets = {
    buildBarTabBuildings: "buildBarSectionBuildings",
    buildBarTabVehicles: "buildBarSectionVehicles",
    buildBarTabInfantry: "buildBarSectionInfantry",
  };
  const isMobile = () => window.matchMedia(MOBILE_TABS_QUERY).matches;

  function setActiveSection(sectionId) {
    Object.values(targets).forEach(sid => {
      const section = document.getElementById(sid);
      if (section) section.classList.toggle("mobileTabActive", sid === sectionId);
    });
    Object.entries(targets).forEach(([btnId, sid]) => {
      const btn = document.getElementById(btnId);
      if (btn) btn.classList.toggle("tabSelected", sid === sectionId);
    });
  }

  Object.entries(targets).forEach(([btnId, sectionId]) => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.onclick = () => {
      if (isMobile()) {
        setActiveSection(sectionId);
        return;
      }
      const section = document.getElementById(sectionId);
      if (section) section.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "start" });
    };
  });

  // По умолчанию (первая сборка ленты / после ресайза на мобильный) —
  // показываем "Здания", т.к. это единственная категория, доступная с
  // первого тика игры (юниты изначально все заблокированы, см.
  // unitUnlockStatus) — логично открыть панель на том, что игрок и так
  // будет строить первым.
  if (isMobile()) setActiveSection("buildBarSectionBuildings");
}

// ИИ (стиль/анимация): подсвечивает кнопку текущего здания в режиме
// размещения (State.buildMode) пульсирующей рамкой (.active, см. CSS
// buildPulse в game.html) — иначе на телефоне, где не видно призрака под
// пальцем так же чётко, как под курсором мыши, легко забыть, что режим
// размещения вообще активен.
function refreshBuildBarActiveState() {
  const bar = document.getElementById("buildBar");
  if (!bar) return;
  bar.querySelectorAll(".buildBtn").forEach(btn => {
    const isActive = State.buildMode && btn.dataset.buildKey === State.buildMode.type;
    btn.classList.toggle("active", !!isActive);
  });
}

// ИИ №35: держит цену на кнопках построек (только здания, dataset.buildKey —
// у кнопок юнитов вместо этого dataset.unitKey, см. buildBuildBar) в
// актуальном состоянии — нужна отдельно от buildBuildBar(), потому что та
// вызывается один раз при старте (13-bootstrap.js), а цена refinery
// меняется в рантайме после каждой постройки станции (см.
// getBuildingCost/REFINERY_PRICE_STEP, 01-config-state.js). Вызывается
// каждый тик из renderHUD() — дёшево (перебор ~10 кнопок), тот же принцип,
// что и у refreshUnitLockState() рядом.
function refreshBuildBarPrices() {
  const bar = document.getElementById("buildBar");
  if (!bar) return;
  const player = State.players[localPlayerId];
  if (!player) return;
  bar.querySelectorAll(".buildBtn[data-build-key]").forEach(btn => {
    const key = btn.dataset.buildKey;
    const small = btn.querySelector("small");
    if (small) small.textContent = `${getBuildingCost(key, player)} кр.`;
  });
}

// ИИ №28 (перенесено из 16-tech-unlock.js при слиянии в buildBuildBar,
// ИИ №30): пересчёт лок-состояния кнопок юнитов — вызывается из
// renderHUD каждый тик. Дёшево (перебор ~10 типов юнитов x зданий
// игрока), масштаб прототипа терпимый.
function refreshUnitLockState() {
  const bar = document.getElementById("buildBar");
  if (!bar) return;
  bar.querySelectorAll(".unitBtn").forEach(btn => {
    const key = btn.dataset.unitKey;
    const status = unitUnlockStatus(key);
    btn.classList.toggle("locked", !status.unlocked);
    const em = btn.querySelector(".lockOverlay em");
    if (em) em.textContent = status.requiredLabel ? `Нужно: ${status.requiredLabel}` : "";
  });
}

// ИИ №4: РЕЖИМ РАЗМЕЩЕНИЯ ЗДАНИЙ.
// Раньше tryStartBuilding() строил здание мгновенно рядом со штабом. Теперь
// клик по кнопке постройки только ВХОДИТ в режим размещения (State.buildMode),
// призрак здания следует за курсором (рисуется в render(), см. drawBuildGhost()),
// а фактическая постройка происходит по ЛКМ через confirmBuildPlacement().
// ПКМ или Escape — отмена режима. Средства списываются ТОЛЬКО в момент
// подтверждения (не при входе в режим), и повторно проверяются на случай,
// если игрок потратил кредиты на что-то другое, пока целился.
function tryStartBuilding(key) {
  if (key === "commandCenter") return; // штаб не строится вручную
  const def = BuildingDefs[key];
  const player = State.players[localPlayerId];
  // ИИ №35: getBuildingCost() вместо def.cost — см. 01-config-state.js.
  if (player.credits < getBuildingCost(key, player)) { logMsg("Недостаточно кредитов", "warn"); return; }
  State.buildMode = { type: key, valid: false };
  refreshBuildBarActiveState();
  logMsg(`Режим размещения: ${def.label} — ЛКМ подтвердить, ПКМ/Esc отменить (на телефоне: тап подтверждает, второй палец отменяет)`);
}

function cancelBuildMode() {
  if (!State.buildMode) return;
  State.buildMode = null;
  refreshBuildBarActiveState();
}

// Проверка, можно ли поставить здание типа key центром в (wx, wy):
// - не должно пересекаться (по прямоугольникам, с зазором BUILD_GAP)
//   ни с другими зданиями (своими/чужими/тенями), ни с узлами ресурсов;
// - упрощение: рельеф/проходимость тайлов не проверяются (карта плоская,
//   препятствий нет — см. общий TODO про патфайндинг в футере ИИ №3).
// ПРАВКА (по прямому запросу пользователя: "здания не ставятся в притык
// в клетках, сделай чтобы ставились в притык клетка в клетку") — раньше
// тут было 6px, что вместе со снапом на тайловую сетку (snapBuildingCenterToGrid,
// 02-utils-canvas.js) делало НЕВОЗМОЖНЫМ поставить два здания в соседние
// клетки (снап кладёт края зданий РОВНО на границу клетки, а +6px с обеих
// сторон требовал ещё лишних 12px зазора между гранями — соседняя клетка
// этого никогда не давала). Занулено — здания, стоящие в соседних клетках
// сетки, имеют края TOUCHING (расстояние между центрами == сумма половин
// сторон), а строгое неравенство "<" ниже НЕ считает точное касание
// пересечением, так что впритык ставить можно, а наложение по-прежнему
// запрещено. Тот же 0 используется у ИИ (ENEMY_BUILD_GAP, 06-enemy-ai.js)
// и в шаге цепочки стен (wallChainStepLength, 18-walls.js) — см. правки
// там же, это единая причина и бага стен ("калитки" в 1 клетку), и этого
// ограничения на обычные здания.
const BUILD_GAP = 0; // зазор между новым зданием и препятствиями, px (0 = впритык клетка-к-клетке)
function isBuildPlacementValid(key, wx, wy) {
  const def = BuildingDefs[key];
  if (!def) return false;

  // ИИ №15: изначально проверялась isWorldPointExplored — здание можно
  // было ставить в "запомненной" зоне вне текущей видимости.
  // ИИ №16/№17: БАГФИКС по прямому запросу пользователя — теперь строить
  // разрешено ТОЛЬКО там, где видно ПРЯМО СЕЙЧАС (isWorldPointVisible), а
  // не там, где когда-то было разведано (там мог появиться враг, пока
  // область была вне обзора — оригинальные RTS ведут себя так же).
  if (GameConfig.fogEnabled && typeof isWorldPointVisible === "function" && !isWorldPointVisible(wx, wy)) {
    return false;
  }

  const halfW = def.w * GameConfig.tileSize / 2 + BUILD_GAP;
  const halfH = def.h * GameConfig.tileSize / 2 + BUILD_GAP;

  // против существующих построек локальной игры (свои + вражеский ИИ)
  for (const b of Object.values(State.buildings)) {
    const bdef = BuildingDefs[b.type];
    if (!bdef) continue;
    const bHalfW = bdef.w * GameConfig.tileSize / 2;
    const bHalfH = bdef.h * GameConfig.tileSize / 2;
    const overlapX = Math.abs(wx - b.x) < (halfW + bHalfW);
    const overlapY = Math.abs(wy - b.y) < (halfH + bHalfH);
    if (overlapX && overlapY) return false;
  }

  // против узлов ресурсов (нельзя строить прямо на них)
  for (const r of Object.values(State.resources)) {
    if (dist(wx, wy, r.x, r.y) < Math.max(halfW, halfH) + 18) return false;
  }

  // против теневых (remote) построек других игроков, если есть
  if (State.remoteGhosts) {
    for (const pdata of Object.values(State.remoteGhosts)) {
      if (!pdata || !pdata.buildings) continue;
      for (const b of Object.values(pdata.buildings)) {
        const bdef = BuildingDefs[b.type];
        if (!bdef) continue;
        const bHalfW = bdef.w * GameConfig.tileSize / 2;
        const bHalfH = bdef.h * GameConfig.tileSize / 2;
        const overlapX = Math.abs(wx - b.x) < (halfW + bHalfW);
        const overlapY = Math.abs(wy - b.y) < (halfH + bHalfH);
        if (overlapX && overlapY) return false;
      }
    }
  }

  return true;
}

function confirmBuildPlacement() {
  if (!State.buildMode) return;
  const key = State.buildMode.type;
  const def = BuildingDefs[key];
  const player = State.players[localPlayerId];
  // ИИ (по прямому запросу пользователя, "здания ставятся строго в
  // клетки"): buildGhostWorld уже должен прийти сюда снапнутым на сетку
  // (см. mousemove/touchstart, 09-input.js) — повторный снап здесь
  // идемпотентен (снап уже снапнутой точки даёт ту же точку) и служит
  // страховкой на случай, если координаты попали сюда каким-то другим
  // путём. wall сюда вообще не попадает (см. её отдельный обработчик,
  // 18-walls.js, который перехватывает клик/тап раньше и строит стену сам).
  const rawWx = State.buildGhostWorld.x, rawWy = State.buildGhostWorld.y;
  const snappedPos = (key !== "wall") ? snapBuildingCenterToGrid(key, rawWx, rawWy) : { x: rawWx, y: rawWy };
  const wx = snappedPos.x, wy = snappedPos.y;

  if (!State.buildMode.valid) {
    // ИИ №16/№17: сообщение теперь про видимость (isWorldPointVisible),
    // а не про "неразведанную зону" (isWorldPointExplored) — см. коммент
    // в isBuildPlacementValid выше. (wx/wy уже посчитаны выше, со снапом.)
    const outOfSight = GameConfig.fogEnabled && typeof isWorldPointVisible === "function" && !isWorldPointVisible(wx, wy);
    logMsg(outOfSight ? "Нельзя строить вне видимости — сначала разведайте эту зону" : "Здесь строить нельзя — слишком близко к другому объекту", "warn");
    return;
  }
  // ИИ №35: getBuildingCost() вместо def.cost — цена refinery растёт с
  // каждой построенной станцией (см. 01-config-state.js). cost считаем
  // ОДИН раз в переменную — иначе после инкремента refineryBuiltCount ниже
  // сообщение в логе показало бы уже НОВУЮ (будущую) цену вместо той,
  // что реально списалась только что.
  const cost = getBuildingCost(key, player);
  if (player.credits < cost) {
    logMsg("Недостаточно кредитов", "warn");
    State.buildMode = null;
    return;
  }

  player.credits -= cost;
  const id = uid("b");
  State.buildings[id] = {
    id, ownerId: localPlayerId, type: key,
    x: wx, y: wy, hp: def.hp, maxHp: def.hp,
    rallyX: wx + 40, rallyY: wy + 40, buildQueue: [],
  };
  // ИИ №35: инкремент СЧЁТЧИКА ПОКУПОК (не текущего числа станций на карте —
  // см. обоснование в 01-config-state.js) сразу после успешной постройки,
  // чтобы следующий вызов getBuildingCost() для refinery вернул цену уже
  // на REFINERY_PRICE_STEP выше.
  if (key === "refinery") {
    player.refineryBuiltCount = (player.refineryBuiltCount || 0) + 1;
    logMsg(`Построено: ${def.label} (следующая станция подорожает на ${REFINERY_PRICE_STEP} кр. — теперь ${getBuildingCost(key, player)} кр.)`);
  } else {
    logMsg(`Построено: ${def.label}`);
  }
  State.buildMode = null;
  refreshBuildBarActiveState();
}

function tryTrainUnit(key) {
  // ИИ №3: теперь это ставит заказ в buildQueue подходящего здания вместо
  // мгновенного создания юнита. Здание выбирается так: если среди
  // выделенных сейчас построек игрока есть подходящее (produces
  // включает key) — используем именно его (позволяет выбрать конкретную
  // казарму при нескольких). Иначе берём первое подходящее здание игрока.
  const def = UnitDefs[key];
  const player = State.players[localPlayerId];
  if (player.credits < def.cost) { logMsg("Недостаточно кредитов", "warn"); return; }

  let building = null;
  State.selection.forEach(id => {
    const b = State.buildings[id];
    if (b && b.ownerId === localPlayerId) {
      const bdef = BuildingDefs[b.type];
      if (bdef && bdef.produces && bdef.produces.includes(key)) building = b;
    }
  });
  if (!building) {
    building = Object.values(State.buildings).find(b => {
      if (b.ownerId !== localPlayerId) return false;
      const bdef = BuildingDefs[b.type];
      return bdef && bdef.produces && bdef.produces.includes(key);
    });
  }
  if (!building) { logMsg(`Нет здания, производящего: ${def.label}`, "warn"); return; }

  player.credits -= def.cost;
  if (!building.buildQueue) building.buildQueue = [];
  building.buildQueue.push({ unitType: key, msLeft: def.buildTime, totalMs: def.buildTime });
  logMsg(`В очередь поставлено: ${def.label}`);
}

// ИИ (стиль/анимация): маленькая подсветка значения при изменении — чисто
// визуальный кэш последнего показанного числа, хранится на самом элементе
// (dataset), чтобы не заводить отдельную переменную модуля.
function flashResValue(el, newText) {
  if (el.dataset.lastVal !== undefined && el.dataset.lastVal !== newText) {
    el.classList.remove("flash");
    // force reflow, чтобы повторный flash перезапускал CSS-анимацию/transition
    void el.offsetWidth;
    el.classList.add("flash");
    clearTimeout(el._flashTimer);
    el._flashTimer = setTimeout(() => el.classList.remove("flash"), 260);
  }
  el.dataset.lastVal = newText;
  el.textContent = newText;
}

function renderHUD() {
  const player = State.players[localPlayerId];
  if (!player) return;
  flashResValue(document.getElementById("resCredits"), String(Math.floor(player.credits)));
  const powerEl = document.getElementById("resPower");
  flashResValue(powerEl, `${player.power}/${player.powerUse}`);
  // ИИ №21: визуальная индикация дефицита питания (см. powerRateMultiplier,
  // 07-game-loop-combat.js) — без неё замедление производства выглядело бы
  // как необъяснимый баг ("почему казарма стала строить медленнее?"), раз
  // само по себе число power/powerUse не объясняет причину без сравнения
  // двух чисел на глаз. classList.toggle идемпотентен — можно звать каждый
  // renderHUD() без отдельной проверки "уже ли выставлен класс".
  powerEl.classList.toggle("powerDeficit", !!player.powerDeficit);
  const unitCount = Object.values(State.units).filter(u => u.ownerId === localPlayerId).length;
  flashResValue(document.getElementById("resUnits"), `${unitCount}/40`);
  document.getElementById("resTick").textContent = State.tick;
  // ИИ №30: раньше вызывалось из отдельной обёртки renderHUD в
  // 16-tech-unlock.js (ИИ №28) — перенесено сюда вместе с самой функцией
  // блокировки, обёртка больше не нужна (см. футер 16-tech-unlock.js).
  refreshUnitLockState();
  // ИИ №35: держит цену refinery на кнопке актуальной (см. её определение
  // выше) — дешёвая операция, тот же тик, что и refreshUnitLockState().
  refreshBuildBarPrices();
}

function renderSelectionPanel() {
  const el = document.getElementById("selContent");
  if (State.selection.size === 0) {
    el.textContent = "Ничего не выбрано";
    return;
  }
  el.innerHTML = "";
  State.selection.forEach(id => {
    const u = State.units[id] || State.buildings[id];
    if (!u) return;
    const def = UnitDefs[u.type] || BuildingDefs[u.type];
    const row = document.createElement("div");
    row.className = "selUnit";
    row.innerHTML = `<span>${def ? def.label : u.type}</span><span>${Math.floor(u.hp)}/${u.maxHp} HP</span>`;
    el.appendChild(row);

    // ИИ №3: прогресс-бар очереди производства для зданий с buildQueue
    if (State.buildings[id] && State.buildings[id].buildQueue && State.buildings[id].buildQueue.length) {
      const b = State.buildings[id];
      b.buildQueue.forEach((order, idx) => {
        const odef = UnitDefs[order.unitType];
        const pct = Math.max(0, Math.min(1, 1 - order.msLeft / order.totalMs));
        const qrow = document.createElement("div");
        qrow.style.margin = "3px 0 6px";
        qrow.innerHTML = `<div style="display:flex;justify-content:space-between;color:var(--text-dim);font-size:11px;">
            <span>${idx === 0 ? "Строится" : "В очереди"}: ${odef.label}</span>
            <span>${idx === 0 ? Math.ceil(order.msLeft/1000) + "с" : ""}</span>
          </div>
          <div class="hpbar"><div class="hpfill" style="width:${idx === 0 ? pct*100 : 0}%;background:var(--accent-gdi);"></div></div>`;
        el.appendChild(qrow);
      });
    }
  });
}
