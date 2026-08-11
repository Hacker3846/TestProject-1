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

  // ИИ (фикс "список выделения дёргается"): renderSelectionPanel зовётся
  // очень часто — на каждое изменение HP выделенных юнитов/зданий, то есть
  // практически непрерывно во время боя, а не только при смене выделения.
  // Старая версия на КАЖДЫЙ такой вызов делала el.innerHTML = "" и
  // пересоздавала ВСЕ строки с нуля. У .selUnit в CSS висит анимация
  // появления (rowIn: fade + сдвиг) — раз DOM-узлы реально уничтожались и
  // создавались заново на каждый вызов, эта анимация запуска перезапускалась
  // у ВСЕХ строк разом при каждом тике боя, что и читалось как "дёргается".
  //
  // Теперь строка для одного и того же юнита/типа/здания — это ОДИН и тот
  // же DOM-узел между вызовами (ключ: тип для сгруппированных юнитов, id
  // для зданий, id+индекс для очереди построек). У уже существующей строки
  // просто обновляется innerHTML содержимого — сам узел не пересоздаётся,
  // поэтому CSS-анимация на нём не перезапускается и HP/прогресс просто
  // меняются на месте. Анимация появления по-прежнему играет — но только у
  // строк, которых не было в предыдущем кадре (юнит реально ДОБАВИЛСЯ в
  // выделение) — это и есть её корректное применение.
  renderSelectionPanel = function () {
    const el = document.getElementById("selContent");
    if (!el) return;

    // Один раз сносим статичную разметку из исходного HTML/предыдущей
    // немодульной версии — дальше #selContent целиком под управлением
    // реестра el._rows и никогда больше не очищается через innerHTML="".
    if (!el._rows) { el._rows = new Map(); el.innerHTML = ""; }
    const rows = el._rows;

    if (State.selection.size === 0) {
      if (!el.dataset.empty) {
        el.innerHTML = `<div class="selEmpty">Ничего не выбрано<br><span>ЛКМ + рамка — выделить отряд</span></div>`;
        el.dataset.empty = "1";
        rows.clear();
      }
      return;
    }
    if (el.dataset.empty) { el.innerHTML = ""; el.dataset.empty = ""; rows.clear(); }

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

    const totalUnitCount = Object.values(groups).reduce((s, g) => s + g.count, 0);

    // Возвращает DOM-узел для ключа — переиспользует существующий (только
    // обновляя его содержимое) либо создаёт новый (тогда и только тогда
    // играет entrance-анимация из CSS).
    const seen = new Set();
    function upsert(key, className, html) {
      seen.add(key);
      let node = rows.get(key);
      if (!node) {
        node = document.createElement("div");
        node.className = className;
        rows.set(key, node);
      }
      node.innerHTML = html;
      return node;
    }

    const order = [];

    // Сводная строка отряда, если выделено больше одного юнита —
    // отвечает на первый же взгляд вопрос "что у меня вообще выделено и
    // насколько оно живое", не считая построчно.
    if (totalUnitCount > 1) {
      order.push("summary");
      upsert("summary", "selSummary", `Отряд: ${totalUnitCount} ед.`);
    }

    Object.entries(groups).forEach(([type, g]) => {
      const key = "g:" + type;
      order.push(key);
      const frac = g.maxHpSum > 0 ? g.hpSum / g.maxHpSum : 1;
      upsert(key, "selUnit selUnitGrouped", `
        <div class="selUnitTop">
          <span class="selIcon">${iconGlyphFor(type)}</span>
          <span class="selName">${g.count > 1 ? `${g.count}× ` : ""}${g.def ? g.def.label : type}</span>
          <span class="selHpText">${Math.floor(g.hpSum)}/${g.maxHpSum} HP</span>
        </div>
        <div class="hpbar"><div class="hpfill" style="width:${frac*100}%;background:${hpFractionColor(frac)};"></div></div>`);
    });

    buildingIds.forEach(id => {
      const b = State.buildings[id];
      const def = BuildingDefs[b.type];
      const frac = b.maxHp > 0 ? Math.max(0, b.hp) / b.maxHp : 1;
      const key = "b:" + id;
      order.push(key);
      upsert(key, "selUnit selBuilding", `
        <div class="selUnitTop">
          <span class="selIcon">${iconGlyphFor(b.type)}</span>
          <span class="selName">${def ? def.label : b.type}</span>
          <span class="selHpText">${Math.floor(b.hp)}/${b.maxHp} HP</span>
        </div>
        <div class="hpbar"><div class="hpfill" style="width:${frac*100}%;background:${hpFractionColor(frac)};"></div></div>`);

      if (b.buildQueue && b.buildQueue.length) {
        b.buildQueue.forEach((order2, idx) => {
          const odef = UnitDefs[order2.unitType];
          const pct = Math.max(0, Math.min(1, 1 - order2.msLeft / order2.totalMs));
          const qkey = `q:${id}:${idx}`;
          order.push(qkey);
          upsert(qkey, "selQueueRow", `<div class="selQueueTop">
              <span>${idx === 0 ? "Строится" : "В очереди"}: ${odef.label}</span>
              <span>${idx === 0 ? Math.ceil(order2.msLeft/1000) + "с" : ""}</span>
            </div>
            <div class="hpbar"><div class="hpfill" style="width:${idx === 0 ? pct*100 : 0}%;background:var(--accent-gdi);"></div></div>`);
        });
      }
    });

    // Расставляем строки в нужном порядке. insertBefore с уже верной
    // позицией — no-op для браузера, так что переиспользованные строки,
    // чей порядок не изменился, вообще не трогаются физически в DOM.
    let prev = null;
    order.forEach(key => {
      const node = rows.get(key);
      const wantedNext = prev ? prev.nextSibling : el.firstChild;
      if (wantedNext !== node) el.insertBefore(node, wantedNext);
      prev = node;
    });

    // Убираем строки тех юнитов/зданий/очередей, которых больше нет в
    // текущем выделении (умерли, деселектнуты, очередь продвинулась).
    for (const [key, node] of rows) {
      if (!seen.has(key)) { node.remove(); rows.delete(key); }
    }
  };
})();
