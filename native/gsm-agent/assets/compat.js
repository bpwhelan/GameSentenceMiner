
(function () {
  function defineCompat(target, name, value) {
    try {
      if (typeof target[name] !== 'function') {
        Object.defineProperty(target, name, { configurable: true, writable: true, value: value });
      }
    } catch (_) {
      try { target[name] = value; } catch (_) {}
    }
  }
  defineCompat(Process, 'findModuleByName', function (name) {
    try { return Process.getModuleByName(name); } catch (_) { return null; }
  });
  defineCompat(Process, 'findModuleByAddress', function (address) {
    try { return Process.getModuleByAddress(address); } catch (_) { return null; }
  });
  defineCompat(Module, 'findExportByName', function (moduleName, exportName) {
    try {
      if (moduleName === null) {
        if (typeof Module.findGlobalExportByName === 'function') {
          return Module.findGlobalExportByName(exportName);
        }
        const modules = Process.enumerateModules();
        for (let i = 0; i < modules.length; i++) {
          const found = modules[i].findExportByName(exportName);
          if (found !== null) return found;
        }
        return null;
      }
      const module = Process.findModuleByName(moduleName);
      return module !== null ? module.findExportByName(exportName) : null;
    } catch (_) {
      return null;
    }
  });
  defineCompat(Module, 'getExportByName', function (moduleName, exportName) {
    const address = Module.findExportByName(moduleName, exportName);
    if (address === null) throw new Error('Unable to find export ' + exportName);
    return address;
  });
})();
