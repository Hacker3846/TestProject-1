/* ---------------------------- ИИ №29: полировка HUD (панель выделения) ---------------------------- */
// Задача пользователя: "улучши остальные детали интерфейса". Правки здесь
// НЕ трогают 10-hud.js напрямую (см. обоснование того же приёма в
// 16-tech-unlock.js/14-game-end.js) — переопределяем renderSelectionPanel
// ПОСЛЕ её объявления, добавляя:
//   - иконку типа юнита/здания (переиспользует unitIconGlyph/buildingIconGlyph
//     из 16-tech-unlock.js — этот файл должен подключаться ПОСЛЕ него,
//     см. game.html);
//   - HP-бар с цветом, зависящим от % здоровья (зелёный->жёлтый->красный),
//     а не фиксированным accent-ally, как было — при массовом выделении
//     раньше все юниты выглядели "одинаково здоровыми" на первый взгляд,
//     даже если один из них при смерти;
//   - группировку при множественном выделении одинаковых юнитов
//     (5x Пехотинец вместо 5 одинаковых строк подряд) — иначе выделение
//     полного отряда пехоты выглядело как нечитаемая простыня одинаковых
//     строк, что прямо противоречит цели "крутой интерфейс".
// Групповая статистика (суммарный HP/maxHP, количество) считается заново
// при каждом рендере из живого State — ничего не кэшируется между тиками,
// тот же принцип, что и у остального HUD (см. 10-hud.js, "Рендер ничего
// не мутирует, только читает").

function hpFractionColor(frac) {
  // 3 ступени по духу военного HUD: боеспособен / повреждён / критично.
  if (frac > 0.6) return "var(--accent-ally-bright)";
  if (frac > 0.3) return "var(--accent-gdi)";
  return "var(--accent-danger)";
}

function iconGlyphFor(type) {
  if (typeof unitIconGlyph === "function" && UnitDefs[type]) return unitIconGlyph(type);
  if (typeof buildingIconGlyph === "function" && BuildingDefs[type]) return buildingIconGlyph(type);
  return "●";
}

// ИИ №29: синхронизация цветных меток в topbar (#playerSwatch/#enemySwatch,
// см. game.html) с реальным State.players[...].color — цвет фракции
// известен только после initLocalPlayer/initEnemyStub (13-bootstrap.js),
// поэтому подшиваемся к тому же renderHUD-хуку, что уже используется для
// лок-состояния юнитов (16-tech-unlock.js) — этот файл должен подключаться
// ПОСЛЕ 16-tech-unlock.js (см. порядок в game.html), чтобы не перетереть
// его обёртку renderHUD, а надстроиться поверх неё.
(function patchTopbarSwatches() {
  if (typeof renderHUD !== "function") return;
  let synced = false;
  const _renderHUD = renderHUD;
  renderHUD = function () {
    _renderHUD();
    if (synced) return; // цвет фракции не меняется во время партии — красим один раз
    const playerSwatch = document.getElementById("playerSwatch");
    const enemySwatch = document.getElementById("enemySwatch");
    const player = State.players[localPlayerId];
    const enemy = typeof enemyPlayerId !== "undefined" ? State.players[enemyPlayerId] : null;
    if (playerSwatch && player && player.color) playerSwatch.style.background = player.color;
    if (enemySwatch && enemy && enemy.color) enemySwatch.style.background = enemy.color;
    if (player && player.color && (!enemy || enemy.color)) synced = true;
  };
})();

(function patchSelectionPanel() {
  if (typeof renderSelectionPanel !== "function") return;

  renderSelectionPanel = function () {
    const el = document.getElementById("selContent");
    if (!el) return;
    if (State.selection.size === 0) {
      el.innerHTML = `<div class="selEmpty">Ничего не выбрано<br><span>ЛКМ + рамка — выделить отряд</span></div>`;
      return;
    }
    el.innerHTML = "";

    // Разделяем на "группируемые" (обычные боевые/рабочие юниты без
    // buildQueue — их можно свернуть в одну строку "5x Пехотинец") и
    // "уникальные" (здания — у каждого своя очередь производства/позиция,
    // сворачивать в одну строку с суммарным HP было бы потерей полезной
    // информации о конкретном здании).
    const groups = {}; // type -> {count, hpSum, maxHpSum, def}
    const buildingIds = [];

    State.selection.forEach(id => {
      if (State.buildings[id]) { buildingIds.push(id); return; }
      const u = State.units[id];
      if (!u) return;
      if (!groups[u.type]) groups[u.type] = { count: 0, hpSum: 0, maxHpSum: 0, def: UnitDefs[u.type] };
      groups[u.type].count++;
      groups[u.type].hpSum += Math.max(0, u.hp);
      groups[u.type].maxHpSum += u.maxHp;
    });

    // Сводная строка отряда, если выделено больше одного юнита —
    // отвечает на первый же взгляд вопрос "что у меня вообще выделено и
    // насколько оно живое", не считая построчно.
    const totalUnitCount = Object.values(groups).reduce((s, g) => s + g.count, 0);
    if (totalUnitCount > 1) {
      const summary = document.createElement("div");
      summary.className = "selSummary";
      summary.textContent = `Отряд: ${totalUnitCount} ед.`;
      el.appendChild(summary);
    }

    Object.entries(groups).forEach(([type, g]) => {
      const frac = g.maxHpSum > 0 ? g.hpSum / g.maxHpSum : 1;
      const row = document.createElement("div");
      row.className = "selUnit selUnitGrouped";
      row.innerHTML = `
        <div class="selUnitTop">
          <span class="selIcon">${iconGlyphFor(type)}</span>
          <span class="selName">${g.count > 1 ? `${g.count}× ` : ""}${g.def ? g.def.label : type}</span>
          <span class="selHpText">${Math.floor(g.hpSum)}/${g.maxHpSum} HP</span>
        </div>
        <div class="hpbar"><div class="hpfill" style="width:${frac*100}%;background:${hpFractionColor(frac)};"></div></div>`;
      el.appendChild(row);
    });

    buildingIds.forEach(id => {
      const b = State.buildings[id];
      const def = BuildingDefs[b.type];
      const frac = b.maxHp > 0 ? Math.max(0, b.hp) / b.maxHp : 1;
      const row = document.createElement("div");
      row.className = "selUnit selBuilding";
      row.innerHTML = `
        <div class="selUnitTop">
          <span class="selIcon">${iconGlyphFor(b.type)}</span>
          <span class="selName">${def ? def.label : b.type}</span>
          <span class="selHpText">${Math.floor(b.hp)}/${b.maxHp} HP</span>
        </div>
        <div class="hpbar"><div class="hpfill" style="width:${frac*100}%;background:${hpFractionColor(frac)};"></div></div>`;
      el.appendChild(row);

      if (b.buildQueue && b.buildQueue.length) {
        b.buildQueue.forEach((order, idx) => {
          const odef = UnitDefs[order.unitType];
          const pct = Math.max(0, Math.min(1, 1 - order.msLeft / order.totalMs));
          const qrow = document.createElement("div");
          qrow.className = "selQueueRow";
          qrow.innerHTML = `<div class="selQueueTop">
              <span>${idx === 0 ? "Строится" : "В очереди"}: ${odef.label}</span>
              <span>${idx === 0 ? Math.ceil(order.msLeft/1000) + "с" : ""}</span>
            </div>
            <div class="hpbar"><div class="hpfill" style="width:${idx === 0 ? pct*100 : 0}%;background:var(--accent-gdi);"></div></div>`;
          el.appendChild(qrow);
        });
      }
    });
  };
})();
