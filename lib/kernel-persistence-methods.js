'use strict';

// Kernel persistence lifecycle facades moved out of kernel.js (#2122):
// descriptor, reload/persist, the SQLite close/reopen pair used by restore,
// and graph optimize/consolidate. Installed on Kernel.prototype by kernel.js
// with the descriptors they had as class methods; `this` is the Kernel
// instance (its graph and memory store).

const { installKernelMethods } = require('./kernel-method-install');

class KernelPersistenceMethods {
  getPersistenceDescriptor() {
    return this._readUseCases.getPersistenceDescriptor();
  }

  reload() {
    return this.graph.load();
  }

  /**
   * Closes every SQLite handle that points at the files restore replaces
   * (graph memory.db and, when it resolves to the same file, the memory store).
   * Agent storage lives on the CLI and is closed by its restore path.
   * Windows cannot rename over an open database file (EPERM), so the restore
   * path closes handles first and calls reopenSqlite() after. See #1848.
   */
  closeSqlite() {
    if (this.graph && typeof this.graph.closeSqlite === 'function') this.graph.closeSqlite();
    if (this.memory && typeof this.memory.close === 'function') this.memory.close();
  }

  /**
   * Reopens the handles closed by closeSqlite() once restore has replaced the
   * backing files. Pair with reload() to repopulate the in-memory graph.
   */
  reopenSqlite() {
    if (this.memory && typeof this.memory.reopen === 'function') this.memory.reopen();
    if (this.graph && typeof this.graph.reopen === 'function') this.graph.reopen();
  }

  persist() {
    return this.graph.save();
  }

  optimize() {
    return this.graph.optimize();
  }
  consolidate(dryRun = true) {
    return this.graph.consolidateEdges(dryRun);
  }
}

function install(Kernel) {
  installKernelMethods(Kernel, KernelPersistenceMethods);
}

module.exports = { install };
