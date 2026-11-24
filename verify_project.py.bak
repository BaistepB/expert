import os
import re
import subprocess
import sys

def check_brackets(text, filename=""):
    # Ignore strings and comments for clean JS checking
    # First, let's do a strict bracket stack check over the source
    # For HTML files, we can also extract script tags and test them separately
    stack = []
    pairs = {')': '(', ']': '[', '}': '{'}
    opening = set(pairs.values())
    closing = set(pairs.keys())
    
    # Simple tokenizer ignoring strings and comments
    i = 0
    n = len(text)
    line = 1
    col = 1
    
    in_single_quote = False
    in_double_quote = False
    in_backtick = False
    in_line_comment = False
    in_block_comment = False
    
    while i < n:
        c = text[i]
        if c == '\n':
            line += 1
            col = 0
            if in_line_comment:
                in_line_comment = False
        col += 1
        
        # Handle comments & strings
        if in_line_comment:
            i += 1
            continue
        if in_block_comment:
            if c == '*' and i + 1 < n and text[i+1] == '/':
                in_block_comment = False
                i += 2
                col += 1
                continue
            i += 1
            continue
            
        if in_single_quote:
            if c == '\\':
                i += 2
                col += 1
                continue
            if c == "'":
                in_single_quote = False
            i += 1
            continue
            
        if in_double_quote:
            if c == '\\':
                i += 2
                col += 1
                continue
            if c == '"':
                in_double_quote = False
            i += 1
            continue
            
        if in_backtick:
            if c == '\\':
                i += 2
                col += 1
                continue
            if c == '`':
                in_backtick = False
            i += 1
            continue
            
        # Check start of comment or regex
        if c == '/' and i + 1 < n:
            if text[i+1] == '/':
                in_line_comment = True
                i += 2
                col += 1
                continue
            elif text[i+1] == '*':
                in_block_comment = True
                i += 2
                col += 1
                continue
            else:
                # Проверяем, является ли '/' началом литерала регулярного выражения RegExp
                # В JSX комбинация '</' всегда является закрывающим тегом, а не регулярным выражением
                j = i - 1
                while j >= 0 and text[j] in ' \t\r\n':
                    j -= 1
                if j >= 0 and text[j] == '<':
                    # Это закрывающий JSX-тег '</...>', пропускаем как обычный символ
                    i += 1
                    col += 1
                    continue
                if j < 0 or text[j] in '([{:;,!&|?=+*-~%^':
                    # Это регулярное выражение! Пропускаем его целиком
                    i += 1
                    col += 1
                    in_char_class = False
                    while i < n:
                        rc = text[i]
                        if rc == '\n':
                            break
                        if rc == '\\':
                            i += 2
                            col += 2
                            continue
                        if rc == '[':
                            in_char_class = True
                        elif rc == ']' and in_char_class:
                            in_char_class = False
                        elif rc == '/' and not in_char_class:
                            # Конец регулярного выражения
                            i += 1
                            col += 1
                            # Пропускаем флаги регекса (g, i, m, s, u, y)
                            while i < n and text[i] in 'gimsuy':
                                i += 1
                                col += 1
                            break
                        i += 1
                        col += 1
                    continue
                
        if c == "'":
            in_single_quote = True
            i += 1
            continue
        if c == '"':
            in_double_quote = True
            i += 1
            continue
        if c == '`':
            in_backtick = True
            i += 1
            continue
            
        # Check brackets
        if c in opening:
            stack.append((c, line, col, i))
        elif c in closing:
            expected = pairs[c]
            if not stack:
                return False, f"Лишняя закрывающая скобка '{c}' в {filename}:{line}:{col}"
            last_open, o_line, o_col, _ = stack.pop()
            if last_open != expected:
                return False, f"Несоответствие скобок: открыта '{last_open}' ({filename}:{o_line}:{o_col}), но закрыта '{c}' ({filename}:{line}:{col})"
                
        i += 1
        
    if stack:
        last_open, o_line, o_col, _ = stack[-1]
        return False, f"Осталась незакрытая скобка '{last_open}' в {filename}:{o_line}:{o_col}"
        
    return True, "Баланс скобок соблюдён"

def verify():
    all_ok = True
    files = ["index.html", "google_apps_script.js", "Code.gs"]
    
    print("=== 1. ПРОВЕРКА БАЛАНСА СКОБОК ===")
    for f in files:
        if not os.path.exists(f):
            print(f"[FAIL] Файл не найден: {f}")
            all_ok = False
            continue
            
        with open(f, "r", encoding="utf-8") as fp:
            content = fp.read()
            
        if f.endswith(".html"):
            # Проверяем ванильный JS-скрипт хаба
            match = re.search(r"<script>(.*?)</script>", content, re.DOTALL)
            if match:
                js_content = match.group(1)
                ok, msg = check_brackets(js_content, f + " [JS-хаб]")
                print(f"{f} [JS-хаб]: {'OK' if ok else 'FAIL'} - {msg}")
                if not ok: all_ok = False
            
            # Проверяем Babel/React скрипт модуля Автоотчет
            babel_match = re.search(r'<script type="text/babel">(.*?)</script>', content, re.DOTALL)
            if babel_match:
                babel_content = babel_match.group(1)
                ok, msg = check_brackets(babel_content, f + " [Babel-Автоотчет]")
                print(f"{f} [Babel-Автоотчет]: {'OK' if ok else 'FAIL'} - {msg}")
                if not ok: all_ok = False

            ok, msg = check_brackets(content, f)
            print(f"{f} [полный файл]: {'OK' if ok else 'FAIL'} - {msg}")
            if not ok: all_ok = False
        else:
            ok, msg = check_brackets(content, f)
            print(f"{f}: {'OK' if ok else 'FAIL'} - {msg}")
            if not ok: all_ok = False
            
    print("\n=== 2. ПРОВЕРКА ЗАПРЕТА localStorage.clear() ===")
    for f in ["index.html"]:
        with open(f, "r", encoding="utf-8") as fp:
            text = fp.read()
        if "localStorage.clear" in text:
            print(f"[FAIL] Обнаружен запрещённый вызов localStorage.clear() в {f}!")
            all_ok = False
        else:
            print(f"[OK] Вызов localStorage.clear() отсутствует в {f}.")
            
    print("\n=== 3. ПРОВЕРКА ЗАЩИТЫ КЛЮЧА expert_app_route_history_v1 ===")
    for f in ["index.html"]:
        with open(f, "r", encoding="utf-8") as fp:
            text = fp.read()
        if "expert_app_route_history_v1" in text and "PROTECTED_KEYS" in text:
            print(f"[OK] Ключ 'expert_app_route_history_v1' объявлен и защищён в PROTECTED_KEYS в {f}.")
        else:
            print(f"[FAIL] Защита ключа 'expert_app_route_history_v1' не найдена в {f}!")
            all_ok = False
            
    print("\n=== 4. ПРОВЕРКА ЗАГОЛОВКА Content-Type: text/plain;charset=utf-8 ===")
    for f in ["index.html"]:
        with open(f, "r", encoding="utf-8") as fp:
            text = fp.read()
        if '"Content-Type": "text/plain;charset=utf-8"' in text or "'Content-Type': 'text/plain;charset=utf-8'" in text or 'Content-Type: text/plain;charset=utf-8' in text:
            print(f"[OK] Обязательный заголовок 'Content-Type: text/plain;charset=utf-8' присутствует в {f}.")
        else:
            print(f"[FAIL] Обязательный заголовок Content-Type: text/plain;charset=utf-8 не найден в {f}!")
            all_ok = False

    print("\n=== 5. СИНТАКСИЧЕСКАЯ ВАЛИДАЦИЯ ЧЕРЕЗ NODE.JS ===")
    res1 = subprocess.run(["node", "-c", "google_apps_script.js"], capture_output=True, text=True)
    if res1.returncode == 0:
        print("[OK] google_apps_script.js: синтаксис корректен")
    else:
        print(f"[FAIL] Ошибка в google_apps_script.js:\n{res1.stderr}")
        all_ok = False
        
    # Check Code.gs by testing syntax via node
    with open("Code.gs", "r", encoding="utf-8") as fp:
        gs_content = fp.read()
    with open("_temp_gs.js", "w", encoding="utf-8") as fp:
        fp.write(gs_content)
    res2 = subprocess.run(["node", "-c", "_temp_gs.js"], capture_output=True, text=True)
    if res2.returncode == 0:
        print("[OK] Code.gs: синтаксис корректен")
    else:
        print(f"[FAIL] Ошибка в Code.gs:\n{res2.stderr}")
        all_ok = False
    if os.path.exists("_temp_gs.js"):
        os.remove("_temp_gs.js")

    # Extract all inline JS from index.html (excluding Babel) to test with node -c
    with open("index.html", "r", encoding="utf-8") as fp:
        html = fp.read()
    script_blocks = re.findall(r'<script(?![^>]*src)(?![^>]*type=["\']text/babel["\'])[^>]*>(.*?)</script>', html, re.DOTALL)
    for idx, s_code in enumerate(script_blocks):
        s_code = s_code.strip()
        if not s_code:
            continue
        temp_name = f"_temp_test_{idx}.js"
        with open(temp_name, "w", encoding="utf-8") as fp:
            fp.write(s_code)
        res = subprocess.run(["node", "-c", temp_name], capture_output=True, text=True)
        if res.returncode == 0:
            print(f"[OK] index.html [JS-блок #{idx + 1}]: синтаксис корректен")
        else:
            print(f"[FAIL] Ошибка в JS-блоке #{idx + 1} index.html:\n{res.stderr}")
            all_ok = False
        if os.path.exists(temp_name):
            os.remove(temp_name)
            
    print("\n" + ("=" * 40))
    if all_ok:
        print("ИТОГ: ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ УСПЕШНО!")
    else:
        print("ИТОГ: ОБНАРУЖЕНЫ ОШИБКИ!")
        sys.exit(1)

if __name__ == "__main__":
    verify()
