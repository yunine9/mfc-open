"""编译范围提示:多模块仓不该整仓编译。

这是提示，不是门禁。编译命令由用户拍板，插件只在用户拍板的那一刻把"整仓编译"
这件事说出来——Java/Maven 多模块仓里整仓 build 动辄十几分钟，而一次交付通常只
碰本服务的 sdk / model / service 几个模块。判断错了也只是多一行提示，不阻断。
"""

import re


_MODULE_PATTERN = re.compile(r"<module>\s*([^<\s][^<]*?)\s*</module>", re.I)
# 交付里最常真正需要编译的模块名特征。命不中不代表不该编译，只用于排序建议。
_LIKELY_HINTS = ("sdk", "model", "service", "api", "core", "biz", "domain")
_SCOPED_MAVEN_FLAGS = ("-pl", "--projects", "-am", "--also-make", "-f", "--file")


def maven_modules(pom_text):
    """Root pom 声明的子模块名，按原始顺序去重。"""
    return tuple(dict.fromkeys(
        name.strip().strip("/")
        for name in _MODULE_PATTERN.findall(str(pom_text or ""))
        if name.strip()
    ))


def _tokens(command):
    return str(command or "").split()


def is_maven_command(command):
    return any(
        token in ("mvn", "mvnw", "./mvnw", "mvn.cmd")
        or token.endswith("/mvn") or token.endswith("\\mvn.cmd")
        for token in _tokens(command))


def is_whole_repo_maven_build(command):
    """Maven 命令没有任何模块限定 → 整仓编译。"""
    if not is_maven_command(command):
        return False
    tokens = _tokens(command)
    return not any(
        token in _SCOPED_MAVEN_FLAGS or token.startswith("-pl=")
        or token.startswith("--projects=")
        for token in tokens)


def likely_delivery_modules(modules, limit=6):
    """把最可能需要编译的模块排前面，纯排序，不做取舍。"""
    def rank(name):
        low = name.lower()
        for index, hint in enumerate(_LIKELY_HINTS):
            if hint in low:
                return index
        return len(_LIKELY_HINTS)
    return tuple(sorted(modules, key=rank)[:limit])


def build_scope_hint(command, modules, defaults_path=".mae-flow-defaults.json"):
    """整仓 Maven 编译时给出一条可直接照抄的收窄写法；否则返回空串。"""
    if not is_whole_repo_maven_build(command):
        return ""
    if not modules:
        return ""
    suggested = likely_delivery_modules(modules)
    return (
        "    ⓘ 这是多模块仓（检测到 %d 个模块），当前编译命令没有限定模块，会编译整仓。\n"
        "      一次交付通常只需要本服务涉及的模块，例如：\n"
        "        mvn -pl %s -am compile -q\n"
        "      （-am 会自动带上被依赖的模块；模块清单请按本次改动实际涉及的调整）\n"
        "      仓内检测到的模块：%s\n"
        "      确定长期用这条命令后，可写进 %s 的「编译方式」，以后自动预填。\n"
        "      整仓编译也不算错，只是慢——这一行只是提示，你说了算。"
        % (
            len(modules),
            ",".join(suggested[:3]) or "<模块名>",
            "、".join(modules[:12]) + ("…" if len(modules) > 12 else ""),
            defaults_path,
        )
    )
