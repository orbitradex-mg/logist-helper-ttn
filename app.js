// Логистический помощник (LogistHelper) - Основной JS файл

// Константы и конфигурация
const DEFAULT_SHEET_ID = '1OebVmeCo4DsB8qckIQEeCkOw-qEBCKBV_zmruxvRfno';
const STORAGE_SHEET_KEY = 'logist_helper_sheet_id';
const STORAGE_RECENT_KEY = 'logist_helper_recent_searches';
const DB_NAME = 'LogistHelperDB';
const STORE_NAME = 'meta_and_data';

const DEFAULT_NP_API_KEY = '223a5ff8b8d0db5bb3ddec54ad9a0271';
const STORAGE_NP_API_KEY = 'logist_helper_np_api_key';
const STORAGE_SENDER_NAME = 'logist_helper_sender_name';
const STORAGE_SENDER_PHONE = 'logist_helper_sender_phone';
const STORAGE_CORS_PROXY = 'logist_helper_cors_proxy';
const DEFAULT_CORS_PROXY = 'https://corsproxy.io/?url=';

let allOrders = []; // Глобальный массив всех заказов
let activeSearchQuery = '';

// Инициализация базы данных IndexedDB
function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
    });
}

// Получение кэшированных данных из IndexedDB
async function getCachedData() {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.get('cached_orders');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    } catch (err) {
        console.error('Ошибка чтения из IndexedDB:', err);
        return null;
    }
}

// Сохранение данных в IndexedDB
async function saveCachedData(data, timestamp) {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const record = { data, timestamp };
            const req = store.put(record, 'cached_orders');
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    } catch (err) {
        console.error('Ошибка записи в IndexedDB:', err);
    }
}

// Нормализация строки из CSV
function normalizeRow(row) {
    return {
        stamp: row['Штамп - уникальный код'] || '',
        ttn: (row['Номер декларации'] || '').trim(),
        shippedQty: row['Количество отправленных единиц'] || '',
        deliveryCost: row['Стоимость доставки'] || '0',
        shipmentDate: row['Дата отгрузки заказа клиенту'] || '',
        shippingMethod: (row['Каким образом произошла отгрузка'] || '').trim(),
        whatWhereBought: row['Что, где купил'] || '',
        purchaseAmount: row['Сумма закупки'] || '0',
        status: (row['Статус заказа (ставится автоматически при наличии даты отгрузки)'] || 'В работе').trim(),
        productionDate: row['Производство — дата готовности заказа'] || '',
        manager: (row['Имя менеджера'] || 'Не указан').trim(),
        orderNumber: (row['№ Заказа'] || '').trim(),
        customer: (row['Заказчик'] || 'Не указан').trim(),
        dueDate: row['Дата Сдачи'] || '',
        autoDescription: row['Описание автоматическое'] || '',
        orderDescription: row['Описание заказа'] || '',
        quantity: row['Тираж'] || '0',
        deliveryAddressRaw: (row['Куда доставить. Город, Телефон, ФИО Получателя, № склада, Адресс'] || '').trim(),
        paidBy: (row['За чей счет?'] || '').trim(),
        sendWithGoods: row['С товаром отправить'] || '',
        purchaseTask: row['Задание Закупить'] || ''
    };
}

// Функция для парсинга телефона из строки
function extractPhone(text) {
    if (!text) return '';
    // Ищем паттерны типа +380..., 380..., 097..., 067-123...
    const regex = /(?:\+?38)?\s?\(?0\d{2}\)?[-.\s]?\d{3}[-.\s]?\d{2}[-.\s]?\d{2}/g;
    const matches = text.match(regex);
    return matches ? matches[0].trim() : '';
}

// Функция для парсинга ТТН Новой Почты и формирования ссылки отслеживания
function getTtnTrackingUrl(ttn) {
    if (!ttn) return '';
    const cleanTtn = ttn.replace(/[-\s.]/g, '');
    // ТТН Новой Почты обычно начинаются с 1, 2, 5 и содержат 14 цифр
    if (/^(1|2|5)\d{13}$/.test(cleanTtn)) {
        return `https://novaposhta.ua/tracking/?cargo_number=${cleanTtn}`;
    }
    return '';
}

// Разбор адреса доставки на удобные поля
function parseAddressDetails(addressRaw) {
    if (!addressRaw) return null;
    
    // Заменяем переносы на переносы строк HTML
    const cleanRaw = addressRaw.replace(/""/g, '"').trim();
    const phone = extractPhone(addressRaw);
    
    // Попытаемся выделить город (обычно первое слово или перед запятыми)
    // Имя получателя (содержит ФИО)
    // Номер склада (например №1, отд. 3)
    let warehouse = '';
    const whMatches = addressRaw.match(/(?:№|отд|отд\.|відділення|відд|склад|склад\s?№)\s?(\d+)/i);
    if (whMatches) {
        warehouse = `Отделение №${whMatches[1]}`;
    }
    
    return {
        raw: cleanRaw.replace(/\n/g, '<br>'),
        phone: phone,
        warehouse: warehouse
    };
}

// Поиск заказов
function searchOrders(query) {
    const cleanQuery = query.trim().toLowerCase();
    
    if (!cleanQuery) {
        return [];
    }
    
    return allOrders.filter(order => {
        const orderNum = order.orderNumber.toLowerCase();
        const customer = order.customer.toLowerCase();
        const ttn = order.ttn.toLowerCase();
        const address = order.deliveryAddressRaw.toLowerCase();
        const manager = order.manager.toLowerCase();
        
        return orderNum.includes(cleanQuery) || 
               customer.includes(cleanQuery) || 
               ttn.includes(cleanQuery) || 
               address.includes(cleanQuery) || 
               manager.includes(cleanQuery);
    });
}

// Загрузка и парсинг данных
async function fetchAndParseData(sheetId, forceSync = false) {
    const syncDot = document.getElementById('syncDot');
    const syncText = document.getElementById('syncText');
    const searchLoader = document.getElementById('searchLoader');
    
    showToast('🔄 Синхронизация с таблицей...', 'ℹ️');
    syncDot.className = 'sync-dot syncing';
    syncText.textContent = 'Загрузка...';
    if (searchLoader) searchLoader.style.display = 'block';
    
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv`;
    
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        
        const csvText = await response.text();
        syncText.textContent = 'Обработка данных...';
        
        Papa.parse(csvText, {
            header: true,
            skipEmptyLines: 'greedy',
            complete: async function(results) {
                if (results.errors && results.errors.length > 0) {
                    console.warn('Ошибки парсинга CSV:', results.errors);
                }
                
                // Нормализуем данные
                allOrders = results.data.map(normalizeRow).filter(order => order.stamp || order.orderNumber);
                
                // Сохраняем в кэш IndexedDB
                const timestamp = Date.now();
                await saveCachedData(allOrders, timestamp);
                
                syncDot.className = 'sync-dot';
                syncText.textContent = `Обновлено: ${new Date(timestamp).toLocaleTimeString()}`;
                if (searchLoader) searchLoader.style.display = 'none';
                
                showToast('✅ Данные успешно обновлены!', '✅');
                
                // Перезапускаем текущий поиск, если он был
                if (activeSearchQuery) {
                    performSearch();
                }
            },
            error: function(err) {
                throw new Error(err.message || 'Ошибка парсинга');
            }
        });
        
    } catch (error) {
        console.error('Ошибка загрузки данных:', error);
        syncDot.className = 'sync-dot';
        syncText.textContent = 'Ошибка загрузки';
        if (searchLoader) searchLoader.style.display = 'none';
        showToast('❌ Ошибка синхронизации с Google Таблицей', '❌');
    }
}

// Загрузка данных при старте (сначала из кэша)
async function initData() {
    const syncDot = document.getElementById('syncDot');
    const syncText = document.getElementById('syncText');
    const sheetId = getSheetId();
    
    document.getElementById('sheetIdInput').value = sheetId;
    
    syncDot.className = 'sync-dot syncing';
    syncText.textContent = 'Загрузка кэша...';
    
    const cached = await getCachedData();
    
    if (cached && cached.data && cached.data.length > 0) {
        allOrders = cached.data;
        
        syncDot.className = 'sync-dot';
        syncText.textContent = `Кэш от: ${new Date(cached.timestamp).toLocaleDateString()} ${new Date(cached.timestamp).toLocaleTimeString()}`;
        
        // В фоновом режиме проверяем обновления из таблицы
        fetchAndParseData(sheetId);
    } else {
        // Если кэша нет, принудительно тянем из сети
        fetchAndParseData(sheetId);
    }
}





// Поиск и отображение результатов
function performSearch() {
    const searchInput = document.getElementById('searchInput');
    activeSearchQuery = searchInput.value;
    
    const results = searchOrders(activeSearchQuery);
    
    const emptyState = document.getElementById('emptyState');
    const ordersList = document.getElementById('ordersList');
    const detailView = document.getElementById('detailView');
    
    if (results.length === 0) {
        // Скроллим наверх на мобильных, чтобы пользователь видел пустой экран результатов поиска
        if (window.innerWidth <= 1024 && window.scrollY > 50) {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        // Ничего не найдено
        emptyState.style.display = 'flex';
        emptyState.innerHTML = `
            <div class="empty-icon">🔍</div>
            <h3>Ничего не найдено</h3>
            <p>По запросу "${activeSearchQuery}" ничего не найдено. Проверьте правильность ввода или фильтры.</p>
        `;
        ordersList.style.display = 'none';
        detailView.style.display = 'none';
    } else if (results.length === 1) {
        // Найден ровно один заказ - сразу показываем детальный вид
        emptyState.style.display = 'none';
        ordersList.style.display = 'none';
        renderOrderDetail(results[0]);
        // Сохраняем в историю
        addRecentSearch(results[0].orderNumber);
    } else {
        // Скроллим наверх на мобильных, чтобы результаты были видны сразу под строкой поиска
        if (window.innerWidth <= 1024 && window.scrollY > 50) {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        // Найдено несколько заказов - выводим список мини-карточек
        emptyState.style.display = 'none';
        detailView.style.display = 'none';
        ordersList.style.display = 'grid';
        
        ordersList.innerHTML = '';
        results.slice(0, 100).forEach(order => { // Ограничиваем рендеринг первыми 100 результатами для скорости
            const isShipped = order.status && order.status.toLowerCase().includes('отгружено');
            const badgeClass = isShipped ? 'badge-shipped' : 'badge-pending';
            
            const card = document.createElement('div');
            card.className = 'glass-panel order-mini-card';
            card.innerHTML = `
                <div class="card-header">
                    <span class="order-num">№ ${order.orderNumber || 'Без номера'}</span>
                    <span class="order-date">${order.dueDate || ''}</span>
                </div>
                <div class="customer-name" title="${order.customer}">${order.customer}</div>
                <div class="card-footer">
                    <span class="badge ${badgeClass}">${order.status || 'В работе'}</span>
                    <span style="color: var(--text-muted)">${order.shippingMethod || ''}</span>
                </div>
            `;
            
            card.addEventListener('click', () => {
                // Подсвечиваем активную карточку
                document.querySelectorAll('.order-mini-card').forEach(c => c.classList.remove('active'));
                card.classList.add('active');
                
                // Рендерим детали
                renderOrderDetail(order);
                addRecentSearch(order.orderNumber);
            });
            
            ordersList.appendChild(card);
        });
        
        if (results.length > 100) {
            const tip = document.createElement('div');
            tip.style.gridColumn = '1 / -1';
            tip.style.textAlign = 'center';
            tip.style.padding = '12px';
            tip.style.color = 'var(--text-secondary)';
            tip.style.fontSize = '0.9rem';
            tip.textContent = `Показаны первые 100 результатов из ${results.length}. Уточните запрос для сужения поиска.`;
            ordersList.appendChild(tip);
        }
    }
}

// Отображение детальной информации о заказе
function renderOrderDetail(order) {
    const detailView = document.getElementById('detailView');
    detailView.style.display = 'block';
    
    const isShipped = order.status && order.status.toLowerCase().includes('отгружено');
    const badgeClass = isShipped ? 'badge-shipped' : 'badge-pending';
    
    // Подготовка ТТН и ссылки
    let ttnHtml = '<span style="color: var(--text-muted)">Нет декларации</span>';
    if (order.ttn) {
        const trackingUrl = getTtnTrackingUrl(order.ttn);
        if (trackingUrl) {
            ttnHtml = `
                <div class="ttn-box">
                    <span class="ttn-number">${order.ttn}</span>
                    <div style="display: flex; gap: 8px;">
                        <button class="ttn-action-btn" onclick="copyText('${order.ttn}', 'ТТН скопирован')" title="Скопировать ТТН">📋</button>
                        <a href="${trackingUrl}" target="_blank" class="ttn-action-btn" title="Отследить на сайте Новой Почты" style="text-decoration: none;">🌐</a>
                    </div>
                </div>
            `;
        } else {
            ttnHtml = `
                <div class="ttn-box">
                    <span class="ttn-number">${order.ttn}</span>
                    <button class="ttn-action-btn" onclick="copyText('${order.ttn}', 'Декларация скопирована')" title="Скопировать">📋</button>
                </div>
            `;
        }
    }
    
    // Парсинг адреса
    const addressInfo = parseAddressDetails(order.deliveryAddressRaw);
    let addressHtml = '<span style="color: var(--text-muted)">Адрес не указан</span>';
    
    if (addressInfo) {
        addressHtml = `
            <div class="address-card">
                <div class="address-item">
                    <span class="address-tag">Получатель и адрес:</span>
                    <div class="address-text">${addressInfo.raw}</div>
                </div>
                ${addressInfo.phone ? `
                    <div class="address-item" style="margin-top: 10px; display: flex; align-items: center; justify-content: space-between;">
                        <div>
                            <span class="address-tag">Телефон:</span>
                            <span class="address-text" style="font-family: monospace; font-size: 1rem;">${addressInfo.phone}</span>
                        </div>
                        <button class="btn btn-secondary" style="padding: 4px 8px; font-size: 0.75rem;" onclick="copyText('${addressInfo.phone}', 'Телефон скопирован')">Копировать</button>
                    </div>
                ` : ''}
            </div>
        `;
    }
    
    detailView.innerHTML = `
        <div class="detail-header">
            <div class="detail-title-section">
                <div class="detail-title">
                    Заказ № ${order.orderNumber || 'Без номера'}
                    <span class="badge ${badgeClass}">${order.status || 'В работе'}</span>
                </div>
                <div class="detail-subtitle">Менеджер: ${order.manager} | Штамп: ${order.stamp || 'нет'}</div>
            </div>
            <div class="detail-actions">
                <button class="btn btn-primary" onclick="openCreateTtnModal('${order.orderNumber}')" style="background: #e52d27; border-color: #e52d27;" title="Оформить ТТН Новой Почты">
                    🚀 Готово
                </button>
                <button class="btn btn-secondary" onclick="copyDeliverySnippet('${order.orderNumber}')" title="Скопировать сводку доставки">
                    📋 Копировать доставку
                </button>
                <button class="btn-icon" onclick="closeDetailView()" title="Закрыть детальный вид">&times;</button>
            </div>
        </div>
        
        <div class="detail-body">
            <!-- Блок: Логистика и доставка (теперь первый) -->
            <div class="detail-section">
                <div class="section-title">🚚 Логистика и доставка</div>
                <div class="info-grid">
                    <div class="info-label">Дата отгрузки:</div>
                    <div class="info-value">${order.shipmentDate || '<span style="color: var(--text-muted)">Еще не отгружен</span>'}</div>
                    
                    <div class="info-label">За чей счет:</div>
                    <div class="info-value">${order.paidBy || 'Не указано'}</div>
                    
                    <div class="info-label">С товаром отправить:</div>
                    <div class="info-value">${order.sendWithGoods || 'Не указано'}</div>
                </div>
                
                <div style="margin-top: 12px;">
                    <span class="address-tag">Декларация (ТТН):</span>
                    ${ttnHtml}
                </div>
                
                <div style="margin-top: 12px;">
                    <span class="address-tag">Куда доставить:</span>
                    ${addressHtml}
                </div>
            </div>

            <!-- Блок: Информация о заказе (теперь второй и выпадающий) -->
            <details class="detail-section collapsible-section">
                <summary class="section-title collapsible-trigger">
                    <span style="display: flex; align-items: center; gap: 8px;">📦 Информация о заказе</span>
                    <span class="chevron">▼</span>
                </summary>
                <div class="collapsible-content" style="margin-top: 16px; display: flex; flex-direction: column; gap: 16px;">
                    <div class="info-grid">
                        <div class="info-label">Заказчик:</div>
                        <div class="info-value">${order.customer}</div>
                        
                        <div class="info-label">Тираж / Кол-во:</div>
                        <div class="info-value">${order.quantity} шт.</div>
                    </div>
                    
                    <div>
                        <span class="address-tag">Дополнительное описание заказа:</span>
                        <div style="background: rgba(255,255,255,0.02); padding: 10px; border-radius: 4px; border: 1px solid var(--border-color); font-size: 0.9rem; margin-top: 4px; white-space: pre-wrap;">
                            ${order.orderDescription || '<span style="color: var(--text-muted)">Нет примечаний</span>'}
                        </div>
                    </div>
                    
                    ${order.purchaseTask ? `
                        <div>
                            <span class="address-tag" style="color: var(--warning)">Задание Закупить:</span>
                            <div style="background: var(--warning-bg); padding: 10px; border-radius: 4px; border: 1px solid var(--warning); font-size: 0.9rem; margin-top: 4px; color: var(--text-primary);">
                                ${order.purchaseTask}
                            </div>
                        </div>
                    ` : ''}
                </div>
            </details>
        </div>
    `;
    
    // Скроллим к деталям на мобильных устройствах
    if (window.innerWidth <= 1024) {
        detailView.scrollIntoView({ behavior: 'smooth' });
    }
}

// Закрыть детальный вид
function closeDetailView() {
    const detailView = document.getElementById('detailView');
    detailView.style.display = 'none';
    
    const results = searchOrders(activeSearchQuery);
    if (results.length > 1) {
        document.getElementById('ordersList').style.display = 'grid';
        document.querySelectorAll('.order-mini-card').forEach(c => c.classList.remove('active'));
    } else {
        document.getElementById('emptyState').style.display = 'flex';
    }
    
    // Скроллим наверх на мобильных, чтобы вернуть пользователя к списку результатов или начальному экрану
    if (window.innerWidth <= 1024 && window.scrollY > 50) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
}

// Вспомогательная функция копирования в буфер
function copyText(text, successMessage) {
    navigator.clipboard.writeText(text).then(() => {
        showToast(successMessage, '📋');
    }).catch(err => {
        console.error('Не удалось скопировать текст:', err);
    });
}

// Формирование и копирование сводки доставки
window.copyDeliverySnippet = function(orderNum) {
    const order = allOrders.find(o => o.orderNumber === orderNum);
    if (!order) return;
    
    const addressInfo = parseAddressDetails(order.deliveryAddressRaw);
    const cleanAddress = order.deliveryAddressRaw.replace(/""/g, '"').replace(/\n/g, ' ');
    
    let text = `Заказ №${order.orderNumber} (Клиент: ${order.customer})\n`;
    text += `Менеджер: ${order.manager}\n`;
    text += `Способ отгрузки: ${order.shippingMethod || 'Не указан'}\n`;
    if (order.ttn) text += `ТТН: ${order.ttn}\n`;
    if (order.paidBy) text += `Оплата доставки: ${order.paidBy}\n`;
    if (order.sendWithGoods) text += `Документы: ${order.sendWithGoods}\n`;
    text += `Адрес доставки: ${cleanAddress}`;
    
    copyText(text, 'Сводка доставки скопирована');
};

// Функция экспонирования некоторых функций глобально для onclick в HTML
window.copyText = copyText;
window.closeDetailView = closeDetailView;

// Показ уведомлений (Toast)
function showToast(message, icon = 'ℹ️') {
    const toast = document.getElementById('toast');
    document.getElementById('toastIcon').textContent = icon;
    document.getElementById('toastText').textContent = message;
    
    toast.className = 'toast show';
    
    // Убираем тост через 3 секунды
    if (window.toastTimeout) clearTimeout(window.toastTimeout);
    window.toastTimeout = setTimeout(() => {
        toast.className = 'toast';
    }, 3000);
}

// Работа со Sheet ID в localStorage
function getSheetId() {
    return localStorage.getItem(STORAGE_SHEET_KEY) || DEFAULT_SHEET_ID;
}

function setSheetId(id) {
    localStorage.setItem(STORAGE_SHEET_KEY, id);
}

function getNPApiKey() {
    return localStorage.getItem(STORAGE_NP_API_KEY) || DEFAULT_NP_API_KEY;
}

function setNPApiKey(key) {
    localStorage.setItem(STORAGE_NP_API_KEY, key);
}

function getSenderName() {
    return localStorage.getItem(STORAGE_SENDER_NAME) || '';
}

function setSenderName(name) {
    localStorage.setItem(STORAGE_SENDER_NAME, name);
}

function getSenderPhone() {
    return localStorage.getItem(STORAGE_SENDER_PHONE) || '';
}

function setSenderPhone(phone) {
    localStorage.setItem(STORAGE_SENDER_PHONE, phone);
}

function getCorsProxy() {
    const stored = localStorage.getItem(STORAGE_CORS_PROXY);
    return stored === null ? DEFAULT_CORS_PROXY : stored;
}

function setCorsProxy(proxy) {
    localStorage.setItem(STORAGE_CORS_PROXY, proxy);
}

// Работа с историей поиска
function getRecentSearches() {
    const recent = localStorage.getItem(STORAGE_RECENT_KEY);
    return recent ? JSON.parse(recent) : [];
}

function addRecentSearch(query) {
    if (!query) return;
    let recent = getRecentSearches();
    // Удаляем дубликаты
    recent = recent.filter(r => r !== query);
    // Добавляем в начало
    recent.unshift(query);
    // Ограничиваем 8 элементами
    recent = recent.slice(0, 8);
    
    localStorage.setItem(STORAGE_RECENT_KEY, JSON.stringify(recent));
    renderRecentSearches();
}

function renderRecentSearches() {
    const recentList = document.getElementById('recentList');
    if (!recentList) return;
    const recent = getRecentSearches();
    
    recentList.innerHTML = '';
    if (recent.length === 0) {
        const item = document.createElement('li');
        item.style.color = 'var(--text-muted)';
        item.style.fontSize = '0.8rem';
        item.textContent = 'Нет недавних поисков';
        recentList.appendChild(item);
        return;
    }
    
    recent.forEach(q => {
        const li = document.createElement('li');
        li.className = 'recent-tag';
        li.textContent = q;
        li.addEventListener('click', () => {
            const searchInput = document.getElementById('searchInput');
            searchInput.value = q;
            performSearch();
        });
        recentList.appendChild(li);
    });
}

// Управление темой оформления
function initTheme() {
    const savedTheme = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    
    const themeIcon = document.getElementById('themeIcon');
    if (savedTheme === 'dark') {
        themeIcon.innerHTML = `<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>`;
    } else {
        themeIcon.innerHTML = `<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="M4.93 4.93l1.41 1.41"/><path d="M17.66 17.66l1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="M6.34 17.66l-1.41 1.41"/><path d="M19.07 4.93l-1.41 1.41"/>`;
    }
}

// ==========================================
// ИНТЕГРАЦИЯ С API НОВОЙ ПОЧТЫ И ОФОРМЛЕНИЕ ТТН
// ==========================================

let currentOrderForTtn = null;
let resolvedTtnData = null;

// Вспомогательная функция для дебаунса ввода
function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

// Универсальный метод вызова API Новой Почты
async function callNPApi(modelName, calledMethod, methodProperties = {}) {
    const apiKey = getNPApiKey();
    if (!apiKey) {
        throw new Error('API-ключ Новой Почты не настроен. Пожалуйста, откройте настройки (пароль 1234).');
    }

    const requestBody = {
        apiKey: apiKey,
        modelName: modelName,
        calledMethod: calledMethod,
        methodProperties: methodProperties
    };

    let url = 'https://api.novaposhta.ua/v2.0/json/';
    const proxy = getCorsProxy().trim();
    
    if (proxy) {
        url = `${proxy}${url}`;
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        throw new Error(`Ошибка сети: ${response.status} ${response.statusText}`);
    }

    const json = await response.json();
    
    // Поддержка некоторых прокси, которые могут возвращать данные в обертках
    let data = json;
    if (json.contents) {
        try {
            data = JSON.parse(json.contents);
        } catch (e) {}
    }

    if (data.success === false || (data.errors && data.errors.length > 0)) {
        const errorMsg = (data.errors && data.errors.join(', ')) || 'Неизвестная ошибка API Новой Почты';
        throw new Error(errorMsg);
    }

    return data.data;
}

// Парсер адресов из Google Таблицы
function parseAddressForTtn(addressRaw) {
    if (!addressRaw) return { lastName: '', firstName: '', phone: '', city: '', warehouse: '', isWarehouse: true };

    const clean = addressRaw.replace(/""/g, '"').trim();
    
    // 1. Извлечение телефона
    const phone = extractPhone(clean);
    let normalizedPhone = '';
    if (phone) {
        const digits = phone.replace(/\D/g, '');
        if (digits.length === 9) {
            normalizedPhone = '380' + digits;
        } else if (digits.length === 10 && digits.startsWith('0')) {
            normalizedPhone = '38' + digits;
        } else if (digits.length === 12 && digits.startsWith('380')) {
            normalizedPhone = digits;
        } else {
            normalizedPhone = digits;
        }
    }

    // 2. Извлечение города
    let city = '';
    const cityMatch = clean.match(/(?:м|г|смт|сел)\.?\s*([А-Яа-яЁёЇїІіЄєҐґ'-]+)/i);
    if (cityMatch && cityMatch[1]) {
        city = cityMatch[1].trim();
    } else {
        const parts = clean.split(/,|\n/);
        for (const part of parts) {
            const p = part.trim();
            if (p && !/\d/.test(p) && p.split(/\s+/).length === 1 && p.length > 3) {
                city = p;
                break;
            }
        }
    }
    
    if (city) {
        city = city.replace(/^(киев|київ)$/i, 'Київ')
                   .replace(/^(одесса|одеса)$/i, 'Одеса')
                   .replace(/^(харьков|харків)$/i, 'Харків')
                   .replace(/^(днепр|дніпро|днепропетровск)$/i, 'Дніпро')
                   .replace(/^(львов|львів)$/i, 'Львів');
    }

    // 3. Извлечение ФИО получателя
    let lastName = '';
    let firstName = '';
    const parts = clean.split(/,|\n|;/);
    for (const part of parts) {
        let p = part.replace(phone, '').trim();
        p = p.replace(/(?:м|г|смт|сел)\.?\s*[А-Яа-яЁёЇїІіЄєҐґ'-]+/gi, '').trim();
        p = p.replace(/(?:№|отд|відд|склад)\s*\d+/gi, '').trim();
        p = p.replace(/(доставка|получатель|отправитель|телефон|нп|нова пошта|нової пошти|оплата|флп|фоп)/gi, '').trim();
        
        const words = p.split(/\s+/).filter(w => w.length > 2 && /^[А-Яа-яЁёЇїІіЄєҐґ]/.test(w));
        if (words.length >= 2 && words.length <= 3) {
            lastName = words[0];
            firstName = words[1];
            break;
        }
    }

    // 4. Определение склада или адреса
    let warehouse = '';
    let isWarehouse = true;
    const whMatch = clean.match(/(?:№|отд|отд\.|відділення|відд|склад|склад\s?№)\s*(\d+)/i);
    if (whMatch) {
        warehouse = whMatch[1];
        isWarehouse = true;
    } else {
        if (/(вул|ул|просп|проспект|бул|бульвар|пл|площадь|пров|переулок)/i.test(clean)) {
            isWarehouse = false;
        }
    }

    return {
        lastName: lastName,
        firstName: firstName,
        phone: normalizedPhone,
        city: city || 'Київ',
        warehouse: warehouse,
        isWarehouse: isWarehouse
    };
}

// Сброс и инициализация таблицы мест
function resetSeatsTable() {
    const tbody = document.getElementById('seatsTableBody');
    tbody.innerHTML = `
        <tr style="border-bottom: 1px solid var(--border-color);">
            <td style="padding: 8px; font-weight: bold;">1</td>
            <td style="padding: 6px;"><input type="number" class="seat-input seat-weight" min="0.1" step="0.1" value="1.0" style="width: 60px; text-align: center; background: #2a2d35; color: white; border: 1px solid var(--border-color); border-radius: 4px; padding: 4px;"></td>
            <td style="padding: 6px;"><input type="number" class="seat-input seat-length" min="1" value="10" style="width: 60px; text-align: center; background: #2a2d35; color: white; border: 1px solid var(--border-color); border-radius: 4px; padding: 4px;"></td>
            <td style="padding: 6px;"><input type="number" class="seat-input seat-width" min="1" value="10" style="width: 60px; text-align: center; background: #2a2d35; color: white; border: 1px solid var(--border-color); border-radius: 4px; padding: 4px;"></td>
            <td style="padding: 6px;"><input type="number" class="seat-input seat-height" min="1" value="10" style="width: 60px; text-align: center; background: #2a2d35; color: white; border: 1px solid var(--border-color); border-radius: 4px; padding: 4px;"></td>
        </tr>
    `;
    tbody.querySelectorAll('.seat-input').forEach(input => {
        input.addEventListener('input', updateVolumetricWeight);
    });
    updateVolumetricWeight();
}

// Расчет объемного веса
function updateVolumetricWeight() {
    let totalVolWeight = 0;
    document.querySelectorAll('#seatsTableBody tr').forEach(tr => {
        const l = parseFloat(tr.querySelector('.seat-length').value) || 0;
        const wd = parseFloat(tr.querySelector('.seat-width').value) || 0;
        const h = parseFloat(tr.querySelector('.seat-height').value) || 0;
        totalVolWeight += (l * wd * h) / 4000;
    });
    document.getElementById('volumetricWeightLabel').textContent = `Общий объемный вес: ${totalVolWeight.toFixed(2)} кг`;
}

// Открытие модального окна оформления ТТН
async function openCreateTtnModal(orderNumber) {
    currentOrderForTtn = allOrders.find(o => o.orderNumber === orderNumber);
    if (!currentOrderForTtn) {
        showToast('Заказ не найден', '❌');
        return;
    }

    // Сброс формы параметров посылки
    document.getElementById('cargoTypeSelect').value = 'Parcel';
    document.getElementById('seatsAmountInput').value = 1;
    
    let cost = parseFloat(currentOrderForTtn.purchaseAmount) || 200;
    if (cost < 100) cost = 200;
    document.getElementById('declaredCostInput').value = Math.round(cost);
    
    // Описание по умолчанию
    document.getElementById('cargoDescriptionInput').value = `Замовлення №${currentOrderForTtn.orderNumber}`;
    
    // За чей счет доставка
    const paidBy = (currentOrderForTtn.paidBy || '').toLowerCase();
    if (paidBy.includes('отправитель') || paidBy.includes('отпр') || paidBy.includes('наш') || paidBy.includes('наш счет')) {
        document.getElementById('payerTypeSelect').value = 'Sender';
    } else {
        document.getElementById('payerTypeSelect').value = 'Recipient';
    }
    
    document.getElementById('paymentMethodSelect').value = 'Cash';

    resetSeatsTable();

    // Открываем модал
    document.getElementById('ttnModal').classList.add('open');

    // Запускаем фоновое распознавание адреса
    resolveRecipientDetails(currentOrderForTtn.deliveryAddressRaw);
}

// Фоновое распознавание и разрешение адреса получателя
async function resolveRecipientDetails(addressRaw) {
    resolvedTtnData = {
        isReady: false,
        error: null,
        firstName: '',
        lastName: '',
        phone: '',
        cityRef: '',
        cityName: '',
        deliveryType: 'warehouse',
        warehouseRef: '',
        warehouseName: '',
        streetRef: '',
        streetName: '',
        building: '',
        flat: ''
    };

    const statusEl = document.getElementById('previewResolvingStatus');
    const addressEl = document.getElementById('previewRecAddress');
    const nameEl = document.getElementById('previewRecName');
    const phoneEl = document.getElementById('previewRecPhone');

    statusEl.textContent = '🔍 Распознавание адреса...';
    statusEl.style.color = 'var(--warning)';
    addressEl.textContent = 'Выполняется запрос к Новой Почте...';
    nameEl.textContent = 'Определяется...';
    phoneEl.textContent = 'Определяется...';

    try {
        const parsed = parseAddressForTtn(addressRaw);
        
        // Показываем имя и телефон получателя из таблицы сразу
        resolvedTtnData.firstName = parsed.firstName || '';
        resolvedTtnData.lastName = parsed.lastName || '';
        resolvedTtnData.phone = parsed.phone || '';

        nameEl.textContent = `${resolvedTtnData.lastName} ${resolvedTtnData.firstName}`.trim() || 'Не определено в таблице';
        phoneEl.textContent = resolvedTtnData.phone || 'Не найден в таблице';

        if (!resolvedTtnData.lastName || !resolvedTtnData.firstName) {
            nameEl.textContent += ' ⚠️ (Нужна фамилия и имя)';
        }
        if (!resolvedTtnData.phone) {
            phoneEl.textContent = '❌ Отсутствует телефон';
        }

        if (!parsed.city) {
            throw new Error('Не удалось определить город в строке адреса');
        }

        // 1. Ищем город в Новой Почте
        statusEl.textContent = `🔍 Ищем город "${parsed.city}"...`;
        const cities = await callNPApi('Address', 'getCities', { FindByString: parsed.city, Limit: 10 });
        if (!cities || cities.length === 0) {
            throw new Error(`Город "${parsed.city}" не найден в базе Новой Почты`);
        }
        
        // Ищем наиболее точное совпадение
        let city = cities.find(c => c.Description.toLowerCase() === parsed.city.toLowerCase()) || cities[0];
        resolvedTtnData.cityName = city.Description;
        resolvedTtnData.cityRef = city.Ref;

        // 2. Ищем отделение или адрес
        if (parsed.isWarehouse && parsed.warehouse) {
            statusEl.textContent = `🔍 Ищем отделение №${parsed.warehouse} в г. ${city.Description}...`;
            resolvedTtnData.deliveryType = 'warehouse';
            
            const warehouses = await callNPApi('Address', 'getWarehouses', {
                CityRef: city.Ref,
                FindByString: parsed.warehouse,
                Limit: 50
            });

            if (!warehouses || warehouses.length === 0) {
                throw new Error(`Отделение №${parsed.warehouse} не найдено в г. ${city.Description}`);
            }

            // Ищем точное совпадение по номеру отделения
            let matchedWh = warehouses.find(w => {
                const whNumMatch = w.Description.match(/(?:№|отд|відд|склад|відділення)\s*(\d+)\b/i);
                return whNumMatch && whNumMatch[1] === parsed.warehouse;
            });

            // Если точного совпадения по номеру нет, пробуем поискать по вхождению номера
            if (!matchedWh) {
                matchedWh = warehouses.find(w => w.Description.includes(`№${parsed.warehouse}`) || w.Description.includes(` № ${parsed.warehouse}`));
            }

            // Если все еще нет, берем первое из найденных
            if (!matchedWh) {
                matchedWh = warehouses[0];
            }

            resolvedTtnData.warehouseRef = matchedWh.Ref;
            resolvedTtnData.warehouseName = matchedWh.Description;

            addressEl.textContent = `${city.Description}, ${matchedWh.Description}`;
        } else {
            // Адресная доставка
            resolvedTtnData.deliveryType = 'doors';
            statusEl.textContent = `🔍 Распознаем улицу...`;

            // Попытка вытащить название улицы
            const streetRegex = /(?:вул|ул|просп|проспект|бул|бульвар|пл|площадь|пров|переулок)\.?\s*([А-Яа-яЁёЇїІіЄєҐґ'\d\s-]+)/i;
            const streetMatch = addressRaw.match(streetRegex);
            let streetName = '';
            if (streetMatch && streetMatch[1]) {
                streetName = streetMatch[1].trim().split(/,|\s{2,}/)[0];
            } else {
                // Если не нашли по ключевому слову, пробуем взять часть строки после города
                const parts = addressRaw.split(',');
                if (parts.length > 1) {
                    streetName = parts[1].trim().replace(/\d+.*/, '').trim(); // убираем цифры и дальше
                }
            }

            if (!streetName) {
                throw new Error('Не удалось определить название улицы в строке адреса');
            }

            statusEl.textContent = `🔍 Ищем улицу "${streetName}" в г. ${city.Description}...`;
            const streets = await callNPApi('Address', 'getStreet', {
                CityRef: city.Ref,
                FindByString: streetName,
                Limit: 15
            });

            if (!streets || streets.length === 0) {
                throw new Error(`Улица "${streetName}" не найдена в г. ${city.Description}`);
            }

            const street = streets[0]; // берем первое совпадение
            resolvedTtnData.streetRef = street.Ref;
            resolvedTtnData.streetName = `${street.StreetsType} ${street.Description}`;

            // Вытаскиваем дом
            const bldgMatch = addressRaw.match(/(?:буд|д|дом|№)\.?\s*(\d+[а-яёїієґ]?)\b/i) || addressRaw.match(/(?:\s|^)(\d+[а-яёїієґ]?)\b/i);
            const building = bldgMatch ? bldgMatch[1] : '';
            resolvedTtnData.building = building;

            if (!building) {
                throw new Error(`Не удалось определить номер дома на улице ${street.Description}`);
            }

            // Вытаскиваем квартиру
            const flatMatch = addressRaw.match(/(?:кв|офис|оф|кв\.)\.?\s*(\d+)\b/i);
            const flat = flatMatch ? flatMatch[1] : '';
            resolvedTtnData.flat = flat;

            addressEl.textContent = `${city.Description}, ${resolvedTtnData.streetName}, буд. ${building}${flat ? ', кв. ' + flat : ''}`;
        }

        // Проверяем обязательные поля получателя для ТТН
        if (!resolvedTtnData.lastName || !resolvedTtnData.firstName) {
            throw new Error('В таблице не указаны имя или фамилия получателя');
        }
        if (!resolvedTtnData.phone) {
            throw new Error('В таблице не указан телефон получателя');
        }

        statusEl.textContent = '✅ Готов к отправке';
        statusEl.style.color = '#4caf50'; // Зеленый цвет успеха
        resolvedTtnData.isReady = true;

    } catch (err) {
        console.error('Ошибка разрешения адреса:', err);
        statusEl.textContent = '❌ Ошибка';
        statusEl.style.color = '#f44336'; // Красный цвет ошибки
        addressEl.innerHTML = `<span style="color: var(--warning); font-size: 0.9rem;">${err.message}</span><br><span style="color: var(--text-muted); font-size: 0.8rem;">Исходный адрес: ${addressRaw}</span>`;
        resolvedTtnData.error = err.message;
        resolvedTtnData.isReady = false;
    }
}

// Создание ТТН
async function createTtn() {
    if (!resolvedTtnData || !resolvedTtnData.isReady) {
        const errMsg = (resolvedTtnData && resolvedTtnData.error) || 'Адрес доставки еще не распознан или содержит ошибки.';
        alert(`Невозможно создать ТТН:\n${errMsg}`);
        return;
    }

    const btnCreate = document.getElementById('btnCreateTtn');
    const originalText = btnCreate.textContent;
    btnCreate.disabled = true;
    btnCreate.textContent = '⏳ Оформление...';

    try {
        const lastName = resolvedTtnData.lastName.trim();
        const firstName = resolvedTtnData.firstName.trim();
        const phone = resolvedTtnData.phone.trim();
        const cityRef = resolvedTtnData.cityRef;
        const deliveryType = resolvedTtnData.deliveryType;
        
        let recipientAddressRef = '';
        let serviceType = 'DoorsWarehouse'; // От адреса ("Пластова 18") до отделения
        
        if (deliveryType === 'warehouse') {
            recipientAddressRef = resolvedTtnData.warehouseRef;
            serviceType = 'DoorsWarehouse';
        } else {
            const streetRef = resolvedTtnData.streetRef;
            const building = resolvedTtnData.building.trim();
            const flat = resolvedTtnData.flat.trim();
            
            serviceType = 'DoorsDoors'; // От адреса до адреса
        }

        const cargoType = document.getElementById('cargoTypeSelect').value;
        const seatsAmount = parseInt(document.getElementById('seatsAmountInput').value) || 1;
        const declaredCost = parseFloat(document.getElementById('declaredCostInput').value) || 200;
        const description = document.getElementById('cargoDescriptionInput').value.trim() || 'Товари для дому';
        const payerType = document.getElementById('payerTypeSelect').value;
        const paymentMethod = document.getElementById('paymentMethodSelect').value;

        // Собираем места
        const optionsSeat = [];
        let totalWeight = 0;
        document.querySelectorAll('#seatsTableBody tr').forEach(tr => {
            const w = parseFloat(tr.querySelector('.seat-weight').value) || 1.0;
            const l = parseFloat(tr.querySelector('.seat-length').value) || 10;
            const wd = parseFloat(tr.querySelector('.seat-width').value) || 10;
            const h = parseFloat(tr.querySelector('.seat-height').value) || 10;
            const vol = (l * wd * h) / 1000000;
            
            totalWeight += w;
            optionsSeat.push({
                weight: w,
                volumetricLength: l,
                volumetricWidth: wd,
                volumetricHeight: h,
                volumetricVolume: vol
            });
        });

        // 1. Получаем данные Отправителя
        showToast('Проверка данных отправителя...', '🔄');
        const senders = await callNPApi('Counterparty', 'getCounterparties', { CounterpartyProperty: 'Sender' });
        if (!senders || senders.length === 0) {
            throw new Error('Отправитель не найден в личном кабинете Новой Почты');
        }
        
        const senderNameSetting = getSenderName().trim().toLowerCase();
        let sender = senders[0];
        if (senderNameSetting) {
            const matched = senders.find(s => s.Description.toLowerCase().includes(senderNameSetting));
            if (matched) sender = matched;
        }
        
        const contacts = await callNPApi('Counterparty', 'getCounterpartyContactPersons', { Ref: sender.Ref });
        if (!contacts || contacts.length === 0) {
            throw new Error('Контактное лицо отправителя не найдено в личном кабинете');
        }
        
        const senderPhoneSetting = getSenderPhone().replace(/\D/g, '');
        let contact = contacts[0];
        if (senderPhoneSetting) {
            const matched = contacts.find(c => c.Phones && c.Phones.replace(/\D/g, '').includes(senderPhoneSetting));
            if (matched) contact = matched;
        }

        const cities = await callNPApi('Address', 'getCities', { FindByString: 'Київ' });
        const kyivCity = cities.find(c => c.Description === 'Київ');
        if (!kyivCity) {
            throw new Error('Город Киев не найден в Новой Почте');
        }

        const streets = await callNPApi('Address', 'getStreet', { CityRef: kyivCity.Ref, FindByString: 'Пластова' });
        const plastovaStreet = streets.find(s => s.Description.includes('Пластова') || s.Description.includes('Пластової'));
        if (!plastovaStreet) {
            throw new Error('Улица Пластова не найдена в Киеве');
        }

        // Сохраняем адрес отправителя (Киев, Пластова 18)
        const savedSenderAddress = await callNPApi('Address', 'save', {
            CounterpartyRef: sender.Ref,
            StreetRef: plastovaStreet.Ref,
            BuildingNumber: '18'
        });
        if (!savedSenderAddress || savedSenderAddress.length === 0) {
            throw new Error('Не удалось получить/сохранить адрес отправителя (ул. Пластова 18)');
        }

        // 2. Создаем или находим получателя (Recipient)
        showToast('Регистрация получателя в НП...', '🔄');
        const recipientData = await callNPApi('Counterparty', 'save', {
            FirstName: firstName,
            LastName: lastName,
            MiddleName: '',
            Phone: phone,
            CounterpartyType: 'PrivatePerson',
            CounterpartyProperty: 'Recipient'
        });
        
        if (!recipientData || recipientData.length === 0) {
            throw new Error('Не удалось зарегистрировать получателя');
        }
        const recipientRef = recipientData[0].Ref;
        const contactRecipientRef = recipientData[0].ContactPerson.data[0].Ref;

        // 3. Сохраняем адрес получателя (если доставка до дверей)
        if (deliveryType === 'doors') {
            showToast('Сохранение адреса доставки...', '🔄');
            const streetRef = resolvedTtnData.streetRef;
            const building = resolvedTtnData.building.trim();
            const flat = resolvedTtnData.flat.trim();
            
            const savedRecAddress = await callNPApi('Address', 'save', {
                CounterpartyRef: recipientRef,
                StreetRef: streetRef,
                BuildingNumber: building,
                Flat: flat
            });
            if (!savedRecAddress || savedRecAddress.length === 0) {
                throw new Error('Не удалось зарегистрировать адрес доставки получателя');
            }
            recipientAddressRef = savedRecAddress[0].Ref;
        }

        // 4. Формируем экспресс-накладную
        showToast('Создание экспресс-накладной...', '🔄');
        
        // Форматируем текущую дату в dd.mm.yyyy
        const today = new Date();
        const dd = String(today.getDate()).padStart(2, '0');
        const mm = String(today.getMonth() + 1).padStart(2, '0');
        const yyyy = today.getFullYear();
        const formattedDate = `${dd}.${mm}.${yyyy}`;

        const ttnParams = {
            Sender: sender.Ref,
            CitySender: kyivCity.Ref,
            SenderAddress: savedSenderAddress[0].Ref,
            ContactSender: contact.Ref,
            SendersPhone: contact.Phones || getSenderPhone() || '380670000000',
            
            Recipient: recipientRef,
            CityRecipient: cityRef,
            RecipientAddress: recipientAddressRef,
            ContactRecipient: contactRecipientRef,
            RecipientsPhone: phone,
            
            DateTime: formattedDate,
            CargoType: cargoType,
            Weight: totalWeight,
            SeatsAmount: seatsAmount,
            Description: description,
            ServiceType: serviceType,
            PaymentMethod: paymentMethod,
            PayerType: payerType,
            Cost: declaredCost,
            OptionsSeat: optionsSeat
        };

        const ttnResponse = await callNPApi('InternetDocument', 'save', ttnParams);
        if (!ttnResponse || ttnResponse.length === 0) {
            throw new Error('Новая Почта вернула пустой ответ при оформлении ТТН');
        }

        const ttnNum = ttnResponse[0].IntDocNumber;
        const ttnRef = ttnResponse[0].Ref;
        const costEstimated = ttnResponse[0].Cost;
        const deliveryDate = ttnResponse[0].EstimatedDeliveryDate;

        // Закрываем модал оформления
        document.getElementById('ttnModal').classList.remove('open');
        showToast('ТТН создана!', '✅');

        // Заполняем модал успеха
        document.getElementById('successTtnNumber').textContent = ttnNum;
        document.getElementById('successTtnRef').textContent = ttnRef;
        document.getElementById('successRecipientName').textContent = `${lastName} ${firstName}`;
        
        let destStr = resolvedTtnData.cityName;
        if (deliveryType === 'warehouse') {
            destStr += `, ${resolvedTtnData.warehouseName}`;
        } else {
            destStr += `, ${resolvedTtnData.streetName}, буд. ${resolvedTtnData.building}`;
            if (resolvedTtnData.flat) {
                destStr += `, кв. ${resolvedTtnData.flat}`;
            }
        }
        document.getElementById('successDestination').textContent = destStr;
        document.getElementById('successPayer').textContent = payerType === 'Recipient' ? 'Отримувач' : 'Відправник';
        document.getElementById('successCost').textContent = costEstimated;
        document.getElementById('successDeliveryDate').textContent = deliveryDate || 'Не вказано';
        document.getElementById('successTrackingLink').href = `https://novaposhta.ua/tracking/?cargo_number=${ttnNum}`;

        // Открываем модал успеха
        document.getElementById('ttnSuccessModal').classList.add('open');

    } catch (err) {
        console.error('Ошибка в createTtn:', err);
        alert(`Ошибка оформления ТТН:\n${err.message}`);
    } finally {
        btnCreate.disabled = false;
        btnCreate.textContent = originalText;
    }
}

// Открытие ссылки для печати
function printNpDocument(printType) {
    const ttnRef = document.getElementById('successTtnRef').textContent;
    const apiKey = getNPApiKey();
    if (!ttnRef || !apiKey) {
        showToast('Нет данных для печати', '⚠️');
        return;
    }
    
    let url = '';
    if (printType === 'a4') {
        url = `https://my.novaposhta.ua/orders/printDocument/orders[]/${ttnRef}/type/pdf/apiKey/${apiKey}`;
    } else if (printType === '100x100') {
        url = `https://my.novaposhta.ua/orders/printMarking100x100/orders[]/${ttnRef}/type/pdf/apiKey/${apiKey}`;
    } else if (printType === '85x85') {
        url = `https://my.novaposhta.ua/orders/printMarkings/orders[]/${ttnRef}/type/pdf/apiKey/${apiKey}`;
    }
    
    if (url) {
        window.open(url, '_blank');
    }
}

// Экспонируем функции глобально
window.openCreateTtnModal = openCreateTtnModal;
window.printNpDocument = printNpDocument;

// Навешивание обработчиков событий
document.addEventListener('DOMContentLoaded', () => {
    // 1. Инициализация темы
    initTheme();
    
    // 2. Инициализация истории поиска
    renderRecentSearches();
    
    // 3. Загрузка данных
    initData();
    
    // 5. Поиск при вводе
    const searchInput = document.getElementById('searchInput');
    searchInput.addEventListener('input', () => {
        performSearch();
    });
    
    // 6. Кнопка ручной синхронизации
    document.getElementById('btnSync').addEventListener('click', () => {
        fetchAndParseData(getSheetId(), true);
    });
    
    // 7. Переключение темы
    document.getElementById('btnTheme').addEventListener('click', () => {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
        
        const themeIcon = document.getElementById('themeIcon');
        if (newTheme === 'dark') {
            themeIcon.innerHTML = `<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>`;
        } else {
            themeIcon.innerHTML = `<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="M4.93 4.93l1.41 1.41"/><path d="M17.66 17.66l1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="M6.34 17.66l-1.41 1.41"/><path d="M19.07 4.93l-1.41 1.41"/>`;
        }
        showToast(`Переключено на ${newTheme === 'dark' ? 'темную' : 'светлую'} тему`, '🌓');
    });
    
    // 8. Управление модальным окном настроек
    const modal = document.getElementById('settingsModal');
    const sheetIdInput = document.getElementById('sheetIdInput');
    const npApiKeyInput = document.getElementById('npApiKeyInput');
    const senderNameInput = document.getElementById('senderNameInput');
    const senderPhoneInput = document.getElementById('senderPhoneInput');
    const corsProxyInput = document.getElementById('corsProxyInput');
    
    document.getElementById('btnSettings').addEventListener('click', () => {
        const password = prompt('Введите пароль для доступа к настройкам:');
        if (password === '1234') {
            sheetIdInput.value = getSheetId();
            npApiKeyInput.value = getNPApiKey();
            senderNameInput.value = getSenderName();
            senderPhoneInput.value = getSenderPhone();
            corsProxyInput.value = getCorsProxy();
            modal.classList.add('open');
        } else if (password !== null) {
            showToast('Неверный пароль!', '❌');
        }
    });
    
    const closeModal = () => modal.classList.remove('open');
    document.getElementById('btnCloseSettings').addEventListener('click', closeModal);
    document.getElementById('btnCancelSettings').addEventListener('click', closeModal);
    
    document.getElementById('btnSaveSettings').addEventListener('click', () => {
        const sheetIdVal = sheetIdInput.value.trim();
        const npApiKeyVal = npApiKeyInput.value.trim();
        const senderNameVal = senderNameInput.value.trim();
        const senderPhoneVal = senderPhoneInput.value.trim();
        const corsProxyVal = corsProxyInput.value.trim();
        
        if (!sheetIdVal) {
            showToast('ID таблицы не может быть пустым', '⚠️');
            return;
        }
        
        setSheetId(sheetIdVal);
        setNPApiKey(npApiKeyVal);
        setSenderName(senderNameVal);
        setSenderPhone(senderPhoneVal);
        setCorsProxy(corsProxyVal);
        
        closeModal();
        showToast('Настройки сохранены', '✅');
        fetchAndParseData(sheetIdVal, true);
    });

    // 9. Оформление ТТН - Интерактив и обработчики
    const ttnModal = document.getElementById('ttnModal');
    const successModal = document.getElementById('ttnSuccessModal');
    
    // Закрытие модалок
    document.getElementById('btnCloseTtnModal').addEventListener('click', () => ttnModal.classList.remove('open'));
    document.getElementById('btnCancelTtn').addEventListener('click', () => ttnModal.classList.remove('open'));
    
    document.getElementById('btnCloseSuccessModal').addEventListener('click', () => successModal.classList.remove('open'));
    
    // Кнопка копирования ТТН
    document.getElementById('btnCopySuccessTtn').addEventListener('click', () => {
        const ttnNum = document.getElementById('successTtnNumber').textContent;
        copyText(ttnNum, 'Номер ТТН скопирован!');
    });
    document.getElementById('successTtnNumber').addEventListener('click', () => {
        const ttnNum = document.getElementById('successTtnNumber').textContent;
        copyText(ttnNum, 'Номер ТТН скопирован!');
    });
    
    // Кнопки печати
    document.getElementById('btnPrintTtnA4').addEventListener('click', () => printNpDocument('a4'));
    document.getElementById('btnPrintMarking100').addEventListener('click', () => printNpDocument('100x100'));
    document.getElementById('btnPrintMarking85').addEventListener('click', () => printNpDocument('85x85'));

    // Кнопка подтверждения создания ТТН
    document.getElementById('btnCreateTtn').addEventListener('click', createTtn);

    // Динамический пересчет объемного веса при изменении количества мест
    const seatsAmountInput = document.getElementById('seatsAmountInput');
    const seatsTableBody = document.getElementById('seatsTableBody');
    
    seatsAmountInput.addEventListener('change', () => {
        let count = parseInt(seatsAmountInput.value) || 1;
        if (count < 1) count = 1;
        if (count > 100) count = 100;
        seatsAmountInput.value = count;
        
        const currentRows = seatsTableBody.querySelectorAll('tr');
        const currentCount = currentRows.length;
        
        if (count > currentCount) {
            for (let i = currentCount + 1; i <= count; i++) {
                const tr = document.createElement('tr');
                tr.style.borderBottom = '1px solid var(--border-color)';
                tr.innerHTML = `
                    <td style="padding: 8px; font-weight: bold;">${i}</td>
                    <td style="padding: 6px;"><input type="number" class="seat-input seat-weight" min="0.1" step="0.1" value="1.0" style="width: 60px; text-align: center; background: #2a2d35; color: white; border: 1px solid var(--border-color); border-radius: 4px; padding: 4px;"></td>
                    <td style="padding: 6px;"><input type="number" class="seat-input seat-length" min="1" value="10" style="width: 60px; text-align: center; background: #2a2d35; color: white; border: 1px solid var(--border-color); border-radius: 4px; padding: 4px;"></td>
                    <td style="padding: 6px;"><input type="number" class="seat-input seat-width" min="1" value="10" style="width: 60px; text-align: center; background: #2a2d35; color: white; border: 1px solid var(--border-color); border-radius: 4px; padding: 4px;"></td>
                    <td style="padding: 6px;"><input type="number" class="seat-input seat-height" min="1" value="10" style="width: 60px; text-align: center; background: #2a2d35; color: white; border: 1px solid var(--border-color); border-radius: 4px; padding: 4px;"></td>
                `;
                tr.querySelectorAll('.seat-input').forEach(input => {
                    input.addEventListener('input', updateVolumetricWeight);
                });
                seatsTableBody.appendChild(tr);
            }
        } else if (count < currentCount) {
            for (let i = currentCount; i > count; i--) {
                currentRows[i - 1].remove();
            }
        }
        updateVolumetricWeight();
    });

    // Инициализация событий для первого ряда мест
    document.querySelectorAll('.seat-input').forEach(input => {
        input.addEventListener('input', updateVolumetricWeight);
    });
});
