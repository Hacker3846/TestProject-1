const firebaseConfig = {
    apiKey: "AIzaSyBH0g83qEUERiDBjgMgRnSJ-s2lvpPtkz4",
    authDomain: "vitrina-e0a00.firebaseapp.com",
    databaseURL: "https://vitrina-e0a00-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "vitrina-e0a00",
    storageBucket: "vitrina-e0a00.firebasestorage.app",
    messagingSenderId: "182787477088",
    appId: "1:182787477088:web:35827926e1e885bb0bfd05"
};

firebase.initializeApp(firebaseConfig);
const database = firebase.database();

let db = { products: [], customers: [], incomingOrders: [], cash: 0, comment: "" };
let expanded = {};

// --- СИНХРОНИЗАЦИЯ ---
database.ref('skladData').on('value', (s) => {
    const d = s.val();
    if (d) {
        db = d;
        if(!db.products) db.products = [];
        if(!db.customers) db.customers = [];
        if(!db.incomingOrders) db.incomingOrders = [];
        renderApp();
    }
});

function saveData() { database.ref('skladData').set(db); }

// --- ИНТЕРФЕЙС ---
function switchTab(id) {
    document.querySelectorAll('.tab-content').forEach(x => x.style.display = 'none');
    document.querySelectorAll('.tab-btn').forEach(x => x.classList.remove('active'));
    document.getElementById(id).style.display = 'block';
    document.getElementById('btn-'+id).classList.add('active');
}

function toggleDetails(id, prefix) {
    const key = prefix + '-' + id;
    expanded[key] = !expanded[key];
    renderApp();
}

// --- СКЛАД ---
function addProduct() {
    const name = document.getElementById('p-name').value;
    const qty = parseInt(document.getElementById('p-qty').value) || 0;
    const price = parseFloat(document.getElementById('p-price').value) || 0;
    const icon = document.getElementById('p-icon').value || '📦';
    if(!name) return;
    db.products.push({ 
        id: Date.now(), icon, name, price, hidden: false,
        history: qty !== 0 ? [{ id: Date.now()+1, qty, date: new Date().toLocaleDateString(), time: new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) }] : [] 
    });
    saveData();
    document.getElementById('p-name').value = '';
}

function addSupply(pId) {
    const amount = parseInt(prompt("Кол-во новой поставки:"));
    if(!amount) return;
    const p = db.products.find(x => x.id === pId);
    if(!p.history) p.history = [];
    p.history.push({ id: Date.now(), qty: amount, date: new Date().toLocaleDateString(), time: new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) });
    saveData();
}

// Удаление конкретной записи из истории (Та самая вишенка)
function deleteSupply(pId, sId) {
    if(confirm("Удалить эту запись из истории?")) {
        const p = db.products.find(x => x.id === pId);
        if(p && p.history) {
            p.history = p.history.filter(h => h.id !== sId);
            saveData();
        }
    }
}

function updateSupplyQty(pId, sId, delta) {
    const p = db.products.find(x => x.id === pId);
    const s = p.history.find(h => h.id === sId);
    if(s) { 
        s.qty += delta; 
        saveData(); 
    }
}

function toggleHideProduct(pId) {
    const p = db.products.find(x => x.id === pId);
    if(p) {
        p.hidden = !p.hidden;
        saveData();
    }
}

function deleteProduct(pId) {
    if(confirm("Удалить товар полностью?")) { db.products = db.products.filter(p => p.id !== pId); saveData(); }
}

// --- ЗАКАЗЧИКИ ---
function addCustomer() {
    const name = document.getElementById('c-name').value;
    if(!name) return;
    db.customers.push({ id: Date.now(), name, orders: [], payCard: 0, payCash: 0, date: new Date().toLocaleDateString() });
    saveData();
    document.getElementById('c-name').value = '';
}

function updateMoney(cId, field, val) {
    const c = db.customers.find(x => x.id === cId);
    if(c) {
        c[field] = parseInt(val) || 0;
        saveData();
    }
}

function resetCustomer(cId) {
    if(confirm('Сбросить заказы и оплаты этого заказчика?')) {
        const c = db.customers.find(x => x.id === cId);
        if(c) {
            c.orders = []; c.payCash = 0; c.payCard = 0;
            saveData();
        }
    }
}

function resetAllCustomers() {
    if(confirm('⚠️ ВНИМАНИЕ: Это полностью очистит список всех заказчиков!')) {
        db.customers = [];
        saveData();
    }
}

function addToOrder(cId) {
    const sel = document.getElementById('sel-'+cId);
    const qty = parseInt(document.getElementById('qty-'+cId).value) || 1;
    const pId = parseInt(sel.value);
    if(!pId) return;
    const c = db.customers.find(x => x.id === cId);
    if(!c.orders) c.orders = [];
    const ex = c.orders.find(o => o.productId === pId);
    if(ex) ex.qty += qty; else c.orders.push({productId: pId, qty: qty});
    saveData();
}

function updateOrderQty(cId, pId, delta) {
    const c = db.customers.find(x => x.id === cId);
    const o = c.orders.find(x => x.productId === pId);
    if(o) { o.qty += delta; if(o.qty <= 0) c.orders = c.orders.filter(x => x.productId !== pId); saveData(); }
}

// --- МОНИТОРИНГ ---
function sendToMonitoring(orderData, status) {
    database.ref('monitoringOrders').push({
        clientName: orderData.clientName,
        items: orderData.items || [],
        status: status,
        timestamp: firebase.database.ServerValue.TIMESTAMP,
        time: new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})
    });
}

// --- ВХОДЯЩИЕ ---
function acceptIncoming(idx) {
    const order = db.incomingOrders[idx];
    sendToMonitoring(order, 'accepted');
    const newC = { 
        id: Date.now(), name: order.clientName, orders: [], 
        payCard: 0, payCash: 0, date: new Date().toLocaleDateString() 
    };
    if (order.items) {
        order.items.forEach(item => {
            const cleanName = item.name.replace(' (ПРЕДЗАКАЗ)', '').trim();
            const p = db.products.find(x => x.name.trim() === cleanName);
            if(p) {
                newC.orders.push({ productId: p.id, qty: item.qty });
                if(!p.history) p.history = [];
                p.history.push({
                    id: Date.now() + Math.random(),
                    qty: -item.qty,
                    clientDebt: order.clientName,
                    date: new Date().toLocaleDateString(),
                    time: new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})
                });
            }
        });
    }
    db.customers.push(newC);
    db.incomingOrders.splice(idx, 1);
    saveData();
    switchTab('customers');
}

function deleteIncoming(idx) { 
    if(confirm("Отклонить заказ?")) { 
        sendToMonitoring(db.incomingOrders[idx], 'rejected');
        db.incomingOrders.splice(idx, 1); 
        saveData(); 
    } 
}

// --- ОТЧЕТЫ (БЕЗ "НА РУКАХ") ---
function sendFullReport() {
    const today = new Date().toLocaleDateString();
    let totalNal = 0, totalCard = 0;
    let txt = `📊 ОТЧЕТ [${today}]\n\n`;

    txt += `📦 СКЛАД:\n`;
    db.products.forEach(p => {
        const stock = (p.history || []).reduce((a, b) => a + b.qty, 0);
        if (!p.hidden) txt += `${p.icon} ${p.name}: ${stock} шт.\n`;
    });

    txt += `\n👥 ЗАКАЗЧИКИ:\n`;
    db.customers.forEach(c => {
        if (c.orders && c.orders.length > 0) {
            const items = c.orders.map(o => {
                const p = db.products.find(x => x.id === o.productId);
                return `- ${p ? p.name : 'Товар'} x${o.qty}`;
            }).join('\n');
            txt += `👤 ${c.name}:\n${items}\n💰 Перевод: ${c.payCard || 0}₽ | Наличка: ${c.payCash || 0}₽\n\n`;
            totalNal += (c.payCash || 0); 
            totalCard += (c.payCard || 0);
        }
    });

    txt += `------------------\n`;
    txt += `💵 Нал: ${totalNal}₽\n`;
    txt += `💳 Перевод: ${totalCard}₽\n`;
    txt += `💰 Касса: ${db.cash || 0}₽\n`;
    txt += `🚀 ИТОГО: ${totalNal + totalCard}₽\n`;
    if(db.comment) txt += `\n📝 Коммент: ${db.comment}`;

    database.ref('reports').push({ reportText: txt, timestamp: firebase.database.ServerValue.TIMESTAMP })
    .then(() => alert("✅ Отчет отправлен!"));
}

// --- ОТРИСОВКА ---
function renderApp() {
    let totalValue = 0;

    // Склад
    document.getElementById('products-list').innerHTML = db.products.map(p => {
        const stock = (p.history || []).reduce((a, b) => a + b.qty, 0);
        totalValue += (stock * p.price);
        const isExp = expanded['pdet-'+p.id];
        return `
            <div class="card ${p.hidden ? 'product-hidden' : ''}">
                <div class="card-header">
                    <b onclick="toggleDetails(${p.id}, 'pdet')">${p.icon} ${p.name}</b>
                    <div class="header-controls">
                        <button class="btn-control" onclick="toggleHideProduct(${p.id})">${p.hidden ? '❌' : '👁️'}</button>
                        <span style="font-weight:bold; margin-right:5px; color: ${stock < 0 ? 'var(--danger)' : 'inherit'}">${stock} шт</span>
                        <button class="btn-control" onclick="deleteProduct(${p.id})">🗑</button>
                    </div>
                </div>
                <div class="details" style="display:${isExp?'block':'none'}">
                    <button class="btn-add-main" onclick="addSupply(${p.id})" style="width:100%">+ ПОСТАВКА</button>
                    ${(p.history || []).map(h => `
                        <div class="history-item" style="${h.qty < 0 ? 'border-left: 4px solid var(--danger); background: #fff1f2;' : ''}">
                            <span>
                                ${h.date} — <b style="color: ${h.qty < 0 ? 'var(--danger)' : 'var(--success)'}">${h.qty} шт</b>
                                ${h.clientDebt ? `<br><small style="color: #64748b">👤 Долг: ${h.clientDebt}</small>` : ''}
                            </span>
                            <div class="flex-row">
                                <button class="btn-mini" onclick="updateSupplyQty(${p.id},${h.id},1)">+</button>
                                <button class="btn-mini" onclick="updateSupplyQty(${p.id},${h.id},-1)">-</button>
                                <button class="btn-mini" style="color:var(--danger)" onclick="deleteSupply(${p.id},${h.id})">🗑</button>
                            </div>
                        </div>`).reverse().join('')}
                </div>
            </div>`;
    }).join('');
    
    document.getElementById('warehouse-footer').innerHTML = `<div class="total-badge" style="background:var(--accent)"><span class="small-total">Выручка при продаже всего:</span><br><span>${totalValue} ₽</span></div>`;

    // Заказчики
    const opts = db.products.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
    document.getElementById('customers-list').innerHTML = db.customers.map(c => {
        let sum = 0;
        const isExp = expanded['cdet-'+c.id];
        (c.orders || []).forEach(o => { const p = db.products.find(x => x.id === o.productId); if(p) sum += p.price * o.qty; });
        return `
            <div class="card">
                <div class="card-header">
                    <b onclick="toggleDetails(${c.id}, 'cdet')">👤 ${c.name}</b>
                    <div class="header-controls">
                        <button class="btn-control" onclick="resetCustomer(${c.id})">🔄</button>
                        <button class="btn-control" onclick="if(confirm('Удалить?')) {db.customers=db.customers.filter(x=>x.id!==${c.id}); saveData()}">🗑</button>
                    </div>
                </div>
                <div class="details" style="display:${isExp?'block':'none'}">
                    <div class="flex-row" style="margin-bottom:12px">
                        <select id="sel-${c.id}">${opts}</select>
                        <input type="number" id="qty-${c.id}" value="1" style="width:75px">
                        <button class="btn-add-main" style="padding:10px 20px" onclick="addToOrder(${c.id})">OK</button>
                    </div>
                    ${(c.orders || []).map(o => {
                        const p = db.products.find(x => x.id === o.productId);
                        return `<div class="order-item"><span>${p?p.name:'?'} ${o.qty}шт</span><div class="flex-row"><button class="btn-mini" onclick="updateOrderQty(${c.id},${o.productId},1)">+</button><button class="btn-mini" onclick="updateOrderQty(${c.id},${o.productId},-1)">-</button></div></div>`;
                    }).join('')}
                    <div class="total-badge"><span>ИТОГО:</span><span>${sum} ₽</span></div>
                    <div class="flex-row" style="margin-top:12px">
                        <input type="number" placeholder="Нал" value="${c.payCash}" onchange="updateMoney(${c.id},'payCash',this.value)">
                        <input type="number" placeholder="Карт" value="${c.payCard}" onchange="updateMoney(${c.id},'payCard',this.value)">
                    </div>
                </div>
            </div>`;
    }).join('');

    let totalNal = 0, totalCard = 0;
    db.customers.forEach(c => { totalNal += (c.payCash || 0); totalCard += (c.payCard || 0); });
    document.getElementById('customers-revenue-box').innerHTML = `
        <div class="card" style="background:var(--accent); color:white; margin-top:20px">
            <div style="display:flex; justify-content:space-between"><span>Выручка:</span><b>${totalNal + totalCard} ₽</b></div>
            <textarea style="width:100%; margin-top:15px; border-radius:15px; padding:12px; border:none; font-family:inherit" placeholder="Комментарий..." onchange="db.comment=this.value; saveData()">${db.comment || ''}</textarea>
        </div>
        <button class="btn-danger-outline" onclick="resetAllCustomers()" style="width:100%; margin-top:10px">⚠️ СБРОСИТЬ ВСЕХ</button>`;

    document.getElementById('new-orders-badge').innerText = db.incomingOrders.length;
    document.getElementById('incoming-orders-list').innerHTML = db.incomingOrders.map((o, i) => {
        const items = (o.items || []).map(it => `<li>${it.name} — <b>${it.qty} шт</b></li>`).join('');
        return `
        <div class="card" style="border-left: 6px solid var(--accent);">
            <b>🛒 ${o.clientName}</b>
            <ul style="font-size: 14px; color: #475569; margin: 10px 0;">${items}</ul>
            <div class="flex-row"><button class="btn-add-main" style="background:var(--success); flex:1" onclick="acceptIncoming(${i})">ПРИНЯТЬ</button><button class="btn-add-main" style="background:var(--danger); width:65px" onclick="deleteIncoming(${i})">✕</button></div>
        </div>`;
    }).join('');
    document.getElementById('cash-input').value = db.cash || 0;
}

function saveCash() { db.cash = parseInt(document.getElementById('cash-input').value) || 0; saveData(); }
