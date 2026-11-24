import re
import os

def build():
    expert_html_path = "index.html"
    autoreport_html_path = r"E:\Antigravity\Автоотчет\index.html"

    with open(expert_html_path, "r", encoding="utf-8") as f:
        expert_html = f.read()

    with open(autoreport_html_path, "r", encoding="utf-8") as f:
        autoreport_html = f.read()

    # 1. Извлекаем Babel-скрипт из Автоотчета
    script_match = re.search(r'<script type="text/babel">(.*?)</script>', autoreport_html, re.DOTALL)
    if not script_match:
        raise Exception("Не найден <script type=\"text/babel\"> в Автоотчете!")
    
    autoreport_babel = script_match.group(1)

    # 2. Модифицируем точку монтирования в Babel-скрипте
    # Было: ReactDOM.createRoot(document.getElementById('root'))
    # Стало: ReactDOM.createRoot(document.getElementById('autoreport-root'))
    autoreport_babel = autoreport_babel.replace(
        "const root = ReactDOM.createRoot(document.getElementById('root'));",
        "const root = ReactDOM.createRoot(document.getElementById('autoreport-root'));"
    )

    # 3. Добавляем в шапку App кнопки «← Хаб» и «💬 Чат»
    target_header_find = """                                {/* Заголовок + живое время */}
                                <div>
                                    <h1
                                        className="text-xl sm:text-2xl font-black text-white tracking-wide select-none"
                                        onClick={handleTitleClick}
                                        style={{ cursor: 'default' }}
                                    >
                                        Автоотчет
                                    </h1>"""

    replacement_header = """                                {/* Заголовок + кнопки навигации + живое время */}
                                <div className="flex items-center gap-3">
                                    <button
                                        type="button"
                                        onClick={() => { if (typeof window.backToHub === 'function') window.backToHub(); }}
                                        className="min-h-[38px] px-3 py-1.5 rounded-xl border border-white/20 bg-white/10 hover:bg-white/20 active:bg-white/30 text-white font-bold text-xs sm:text-sm flex items-center gap-1.5 transition-all shadow-sm"
                                        title="Домой"
                                    >
                                        <span>← Хаб</span>
                                    </button>
                                    <div>
                                        <h1
                                            className="text-xl sm:text-2xl font-black text-white tracking-wide select-none"
                                            onClick={handleTitleClick}
                                            style={{ cursor: 'default' }}
                                        >
                                            Автоотчет
                                        </h1>"""

    if target_header_find in autoreport_babel:
        autoreport_babel = autoreport_babel.replace(target_header_find, replacement_header, 1)
    else:
        print("[WARN] Не найден target_header_find для добавления кнопки «← Хаб»")

    target_chat_btn_find = """                                {/* Правая часть: режимы, звук, облако, настройки */}
                                <div className="flex items-center gap-2 flex-wrap">"""

    replacement_chat_btn = """                                {/* Правая часть: чат, режимы, звук, облако, настройки */}
                                <div className="flex items-center gap-2 flex-wrap">
                                    <button
                                        type="button"
                                        onClick={() => { if (typeof window.openDrawerChat === 'function') window.openDrawerChat(); }}
                                        className="min-h-[38px] px-3 py-1.5 rounded-xl border border-white/20 bg-white/10 hover:bg-white/20 active:bg-white/30 text-white font-bold text-xs sm:text-sm flex items-center gap-1.5 transition-all shadow-sm"
                                        title="Открыть чат"
                                    >
                                        <span>💬 Чат</span>
                                    </button>"""

    if target_chat_btn_find in autoreport_babel:
        autoreport_babel = autoreport_babel.replace(target_chat_btn_find, replacement_chat_btn, 1)
    else:
        print("[WARN] Не найден target_chat_btn_find для добавления кнопки «💬 Чат»")

    # 4. Поддержка автосинхронизации сессии пользователя из хаба
    target_auth_state_find = """            /* ── Идентификатор эксперта (телефон / ПИН-код) ── */
            const [userPhone, setUserPhone] = useState(() => {
                return normalizePhone(localStorage.getItem('expert_app_user_phone') || '');
            });
            const [userPin, setUserPin] = useState(() => {
                return normalizePin(localStorage.getItem('expert_app_user_pin') || '');
            });
            const [isAuthVerified, setIsAuthVerified] = useState(() => {
                const p = normalizePhone(localStorage.getItem('expert_app_user_phone') || '');
                const pin = normalizePin(localStorage.getItem('expert_app_user_pin') || '');
                const verified = localStorage.getItem('expert_app_auth_verified');
                return p.length === 11 && pin.length === 4 && verified === 'true';
            });"""

    replacement_auth_state = """            /* ── Идентификатор эксперта (телефон / ПИН-код) ── */
            const [userPhone, setUserPhone] = useState(() => {
                const hubUser = window.__EXPERT_USER__;
                return normalizePhone((hubUser && hubUser.phone) || localStorage.getItem('expert_app_user_phone') || '');
            });
            const [userPin, setUserPin] = useState(() => {
                const hubUser = window.__EXPERT_USER__;
                return normalizePin((hubUser && hubUser.pin) || localStorage.getItem('expert_app_user_pin') || '');
            });
            const [isAuthVerified, setIsAuthVerified] = useState(() => {
                const hubUser = window.__EXPERT_USER__;
                const p = normalizePhone((hubUser && hubUser.phone) || localStorage.getItem('expert_app_user_phone') || '');
                const pin = normalizePin((hubUser && hubUser.pin) || localStorage.getItem('expert_app_user_pin') || '');
                const verified = localStorage.getItem('expert_app_auth_verified') || (hubUser ? 'true' : '');
                return p.length === 11 && pin.length === 4 && verified === 'true';
            });

            /* Слушатель изменений сессии из хаба «Эксперт» */
            useEffect(() => {
                const onSessionChange = (e) => {
                    const sess = e.detail;
                    if (sess && sess.phone && sess.pin) {
                        const cleanP = normalizePhone(sess.phone);
                        const cleanPin = normalizePin(sess.pin);
                        setUserPhone(cleanP);
                        setUserPin(cleanPin);
                        setIsAuthVerified(true);
                        if (sess.fullName) {
                            setProfile(prev => prev.fullName ? prev : { ...prev, fullName: sess.fullName });
                        }
                    }
                };
                window.addEventListener('expert:session_changed', onSessionChange);
                return () => window.removeEventListener('expert:session_changed', onSessionChange);
            }, []);"""

    if target_auth_state_find in autoreport_babel:
        autoreport_babel = autoreport_babel.replace(target_auth_state_find, replacement_auth_state, 1)
    else:
        print("[WARN] Не найден target_auth_state_find")

    # 5. Интеграция DEFAULT_GOOGLE_SCRIPT_URL с EXPERT_CONFIG.gasUrl
    autoreport_babel = autoreport_babel.replace(
        "const DEFAULT_GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyTbFwjYlBPXp7n18cAIX_27z2TpuErD2-6F20J7v59YqaBCWY_8jZYl5KBKo4YV8Y/exec';",
        "const DEFAULT_GOOGLE_SCRIPT_URL = (typeof EXPERT_CONFIG !== 'undefined' && EXPERT_CONFIG.gasUrl) ? EXPERT_CONFIG.gasUrl : 'https://script.google.com/macros/s/AKfycbyTbFwjYlBPXp7n18cAIX_27z2TpuErD2-6F20J7v59YqaBCWY_8jZYl5KBKo4YV8Y/exec';"
    )

    # 6. Извлекаем вспомогательные стили (анимации снежинок, pastel, hide-scrollbar)
    extra_styles = """
    /* Стили модуля «Автоотчет» */
    .hide-scrollbar::-webkit-scrollbar, .no-scrollbar::-webkit-scrollbar { display: none; }
    .hide-scrollbar, .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
    @keyframes snowfall {
        0%   { transform: translateY(-10vh) translateX(0)    rotate(0deg);   opacity: 0.9; }
        50%  { transform: translateY(50vh)  translateX(15px) rotate(180deg); opacity: 0.6; }
        100% { transform: translateY(105vh) translateX(-15px) rotate(360deg); opacity: 0.1; }
    }
    .snowflake {
        position: fixed;
        top: -5vh;
        color: #ffffff;
        pointer-events: none;
        z-index: 45;
        user-select: none;
        animation: snowfall linear infinite;
    }
    .bg-pastel-theme {
        background: linear-gradient(90deg, #FBBBB4 0%, #FBDEB4 25%, #CAFBB4 50%, #B4FBFA 75%, #C6C9FC 100%);
        background-attachment: fixed;
    }
    #autoreport-root {
        width: 100%;
        min-height: 100%;
        position: relative;
    }
    """

    # 7. Добавляем библиотеки в <head>
    head_libraries = """
  <!-- Внешние библиотеки для модуля «Автоотчёт» -->
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            amber: {
              500: '#f59e0b', 600: '#d97706', 700: '#b45309',
              800: '#92400e', 900: '#78350f',
            }
          }
        }
      }
    }
  </script>
  <script src="https://unpkg.com/react@18/umd/react.production.min.js" crossorigin></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js" crossorigin></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js"></script>
"""

    # Вставляем библиотеки в <head> перед существующим <style>
    if "<!-- Внешние библиотеки для модуля «Автоотчёт» -->" not in expert_html:
        expert_html = expert_html.replace("<style>", head_libraries + "\n  <style>" + extra_styles, 1)

    # 8. Заменяем контейнер-заглушку на рабочий контейнер с точкой монтирования
    target_placeholder = """        <!-- Контейнер модуля: Автоотчёт (подключается первым) -->
        <div class="module-container" id="moduleContainer-autoreport">
          <div class="card">
            <div class="module-placeholder-header">
              <div class="app-icon" style="font-size: 32px; width: 64px; height: 64px;">🚗</div>
              <div>
                <h2 style="margin: 0 0 4px; font-size: 22px;">Модуль «Автоотчёт»</h2>
                <div style="color: var(--muted); font-size: 14px;">Учёт поездок, пробега, топлива и путевых листов</div>
              </div>
            </div>
            <div class="module-placeholder-body">
              <p style="margin-top: 0;"><strong>Контейнер модуля «Автоотчёт» подготовлен к подключению (этап 1).</strong></p>
              <div class="module-meta-note">
                В этом контейнере будет развёрнут полный функционал путевых листов, расчёта норм топлива (лето/зима) и синхронизации с листами <code>Месяцы</code>, <code>Профили</code> и <code>Кэш_расстояний</code>. Чат в модуле доступен в выдвижной панели по кнопке вверху.
              </div>
            </div>
          </div>
        </div>"""

    replacement_container = """        <!-- Контейнер модуля: Автоотчёт (подключён) -->
        <div class="module-container" id="moduleContainer-autoreport" style="display: none;">
          <div id="autoreport-root"></div>
        </div>"""

    if target_placeholder in expert_html:
        expert_html = expert_html.replace(target_placeholder, replacement_container, 1)
    else:
        print("[WARN] Не найден target_placeholder для замены контейнера")

    # 9. Обновляем логику синхронизации авторизации в скрипте хаба
    # Добавляем синхронизацию window.__EXPERT_USER__ и вызов событий
    hub_sync_code = """
    function syncHubSessionToModules() {
      if (appState.session) {
        window.__EXPERT_USER__ = {
          phone: appState.session.phone,
          pin: appState.session.pin,
          fullName: appState.session.fullName || ""
        };
        try {
          localStorage.setItem('expert_app_user_phone', appState.session.phone);
          localStorage.setItem('expert_app_user_pin', appState.session.pin);
          localStorage.setItem('expert_app_auth_verified', 'true');
          if (EXPERT_CONFIG.gasUrl) {
            const currentSettings = JSON.parse(localStorage.getItem('expert_report_settings') || '{}');
            currentSettings.googleScriptUrl = EXPERT_CONFIG.gasUrl;
            localStorage.setItem('expert_report_settings', JSON.stringify(currentSettings));
          }
        } catch (e) {}
        window.dispatchEvent(new CustomEvent('expert:session_changed', { detail: appState.session }));
      } else {
        window.__EXPERT_USER__ = null;
        try {
          localStorage.removeItem('expert_app_user_phone');
          localStorage.removeItem('expert_app_user_pin');
          localStorage.removeItem('expert_app_auth_verified');
        } catch (e) {}
        window.dispatchEvent(new CustomEvent('expert:session_changed', { detail: null }));
      }
    }
    window.backToHub = backToHub;
    window.openDrawerChat = openDrawerChat;
"""

    if "function syncHubSessionToModules()" not in expert_html:
        # Вставляем после syncAuthUI
        expert_html = expert_html.replace("syncAuthUI();\n    }", "syncAuthUI();\n      syncHubSessionToModules();\n    }" + hub_sync_code, 1)

    # 10. Добавляем Babel-скрипт Автоотчета в конец body перед </body>
    if "<div id=\"autoreport-root\">" in expert_html:
        # Добавляем скрипт Автоотчета
        autoreport_script_tag = f"\n  <!-- Модуль «Автоотчёт» (React + Babel) -->\n  <script type=\"text/babel\">\n{autoreport_babel}\n  </script>\n"
        expert_html = expert_html.replace("</body>", autoreport_script_tag + "</body>")

    # Сохраняем объединённый index.html
    with open(expert_html_path, "w", encoding="utf-8") as f:
        f.write(expert_html)

    print("[OK] Объединённый index.html успешно собран!")

if __name__ == "__main__":
    build()
