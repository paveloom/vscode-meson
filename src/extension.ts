import * as vscode from "vscode";
import { getMesonTasks, getTasks, runTask, runFirstTask } from "./tasks";
import { MesonProjectExplorer } from "./treeview";
import { TargetNode } from "./treeview/nodes/targets";
import {
  extensionConfiguration,
  extensionConfigurationSet,
  genEnvFile,
  useCompileCommands,
  clearCache,
  checkMesonIsConfigured,
  getOutputChannel,
  relativeBuildDir,
  rootMesonFiles,
} from "./utils";
import { DebugConfigurationProviderCppdbg } from "./debug/cppdbg";
import { DebugConfigurationProviderLldb } from "./debug/lldb";
import { testDebugHandler, testRunHandler, rebuildTests } from "./tests";
import { activateLinters } from "./linters";
import { activateFormatters } from "./formatters";
import { SettingsKey, TaskQuickPickItem } from "./types";
import { createLanguageServerClient } from "./lsp/common";
import { dirname, relative } from "path";

export let extensionPath: string;
export let workspaceState: vscode.Memento;
let explorer: MesonProjectExplorer;
let watcher: vscode.FileSystemWatcher;
let compileCommandsWatcher: vscode.FileSystemWatcher;
let mesonWatcher: vscode.FileSystemWatcher;
let controller: vscode.TestController;

export async function activate(ctx: vscode.ExtensionContext) {
  extensionPath = ctx.extensionPath;
  workspaceState = ctx.workspaceState;

  if (!vscode.workspace.workspaceFolders) {
    return;
  }

  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const mesonFiles = await rootMesonFiles();
  if (mesonFiles.length === 0) {
    return;
  }

  let configurationChosen = false;
  let savedMesonFile = workspaceState.get<string>("mesonbuild.mesonFile");
  if (savedMesonFile) {
    const filePaths = mesonFiles.map((file) => file.fsPath);
    if (filePaths.includes(savedMesonFile)) {
      configurationChosen = workspaceState.get<boolean>("mesonbuild.configurationChosen") ?? false;
    } else {
      savedMesonFile = undefined;
    }
  }

  const mesonFile = savedMesonFile ?? mesonFiles[0].fsPath;
  const sourceDir = dirname(mesonFile);
  const buildDir = relativeBuildDir(mesonFile);

  workspaceState.update("mesonbuild.mesonFile", mesonFile);
  workspaceState.update("mesonbuild.buildDir", buildDir);
  workspaceState.update("mesonbuild.sourceDir", sourceDir);
  workspaceState.update("mesonbuild.configurationChosen", undefined);

  explorer = new MesonProjectExplorer(ctx, root, buildDir);

  const providers = [DebugConfigurationProviderCppdbg, DebugConfigurationProviderLldb];
  providers.forEach((provider) => {
    const p = new provider(buildDir);
    ctx.subscriptions.push(
      vscode.debug.registerDebugConfigurationProvider(p.type, p, vscode.DebugConfigurationProviderTriggerKind.Dynamic),
    );
  });

  const updateHasProject = async () => {
    const mesonFiles = await vscode.workspace.findFiles("**/meson.build");
    vscode.commands.executeCommand("setContext", "mesonbuild.hasProject", mesonFiles.length > 0);
  };
  mesonWatcher = vscode.workspace.createFileSystemWatcher("**/meson.build", false, true, false);
  mesonWatcher.onDidCreate(updateHasProject);
  mesonWatcher.onDidDelete(updateHasProject);
  ctx.subscriptions.push(mesonWatcher);
  await updateHasProject();

  controller = vscode.tests.createTestController("meson-test-controller", "Meson test controller");
  controller.createRunProfile(
    "Meson debug test",
    vscode.TestRunProfileKind.Debug,
    (request, token) => testDebugHandler(controller, request, token),
    true,
  );
  controller.createRunProfile(
    "Meson run test",
    vscode.TestRunProfileKind.Run,
    (request, token) => testRunHandler(controller, request, token),
    true,
  );
  ctx.subscriptions.push(controller);

  let mesonTasks: Thenable<vscode.Task[]> | null = null;
  ctx.subscriptions.push(
    vscode.tasks.registerTaskProvider("meson", {
      provideTasks() {
        mesonTasks ??= getMesonTasks(buildDir, sourceDir);
        return mesonTasks;
      },
      resolveTask() {
        return null;
      },
    }),
  );

  const changeHandler = async () => {
    mesonTasks = null;
    clearCache();
    await rebuildTests(controller);
    await genEnvFile(buildDir);
    explorer.refresh();
  };
  watcher = vscode.workspace.createFileSystemWatcher(`${buildDir}/build.ninja`, false, false, true);
  watcher.onDidChange(changeHandler);
  watcher.onDidCreate(changeHandler);
  ctx.subscriptions.push(watcher);
  await genEnvFile(buildDir);

  // Refresh if the extension configuration is changed.
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
      if (e.affectsConfiguration("mesonbuild.buildFolder")) {
        // buildFolder is rather ingrained right now, so changes there require a full reload.
        vscode.commands.executeCommand("workbench.action.reloadWindow");
      } else if (e.affectsConfiguration("mesonbuild")) {
        changeHandler();
      }
    }),
  );

  const compileCommandsHandler = async () => {
    await useCompileCommands(buildDir);
  };
  compileCommandsWatcher = vscode.workspace.createFileSystemWatcher(
    `${buildDir}/compile_commands.json`,
    false,
    false,
    true,
  );
  compileCommandsWatcher.onDidChange(compileCommandsHandler);
  compileCommandsWatcher.onDidCreate(compileCommandsHandler);
  ctx.subscriptions.push(compileCommandsWatcher);
  await useCompileCommands(buildDir);

  ctx.subscriptions.push(
    vscode.commands.registerCommand("mesonbuild.openBuildFile", async (node: TargetNode) => {
      const file = node.getTarget().defined_in;
      const uri = vscode.Uri.file(file);
      await vscode.commands.executeCommand("vscode.open", uri);
    }),
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand("mesonbuild.reconfigure", async () => {
      runFirstTask("reconfigure");
    }),
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand("mesonbuild.build", async (name?: string) => {
      pickAndRunTask("build", name);
    }),
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand("mesonbuild.install", async () => {
      runFirstTask("install");
    }),
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand("mesonbuild.test", async (name?: string) => {
      pickAndRunTask("test", name);
    }),
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand("mesonbuild.benchmark", async (name?: string) => {
      pickAndRunTask("benchmark", name);
    }),
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand("mesonbuild.clean", async () => {
      runFirstTask("clean");
    }),
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand("mesonbuild.run", async () => {
      pickAndRunTask("run");
    }),
  );

  if (!checkMesonIsConfigured(buildDir)) {
    let configureOnOpen = configurationChosen || extensionConfiguration(SettingsKey.configureOnOpen);
    if (configureOnOpen === "ask") {
      enum Options {
        yes = "Yes",
        always = "Always",
        no = "No",
        never = "Never",
      }

      const response = await vscode.window.showInformationMessage(
        "Meson project detected in this workspace but does not seems to be configured. Would you like VS Code to configure it?",
        ...Object.values(Options),
      );

      switch (response) {
        case Options.no:
          break;

        case Options.never:
          extensionConfigurationSet(SettingsKey.configureOnOpen, false, vscode.ConfigurationTarget.Workspace);
          break;

        case Options.yes:
          configureOnOpen = true;
          break;

        case Options.always:
          extensionConfigurationSet(SettingsKey.configureOnOpen, true, vscode.ConfigurationTarget.Workspace);
          configureOnOpen = true;
          break;
      }
    }

    if (configureOnOpen) {
      let cancel = false;
      if (!configurationChosen && mesonFiles.length > 1) {
        const items = mesonFiles.map((file, index) => ({ index: index, label: relative(root, file.fsPath) }));
        items.sort((a, b) => a.label.localeCompare(b.label));
        const selection = await vscode.window.showQuickPick(items, {
          canPickMany: false,
          title: "Select configuration to use.",
          placeHolder: "path/to/meson.build",
        });
        if (selection && mesonFiles[selection.index].fsPath !== mesonFile) {
          await workspaceState.update("mesonbuild.mesonFile", mesonFiles[selection.index].fsPath);
          await workspaceState.update("mesonbuild.configurationChosen", true);
          vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
        cancel = selection === undefined;
      }
      if (!cancel) {
        runFirstTask("reconfigure");
      }
    }
  } else {
    await rebuildTests(controller);
  }

  const downloadLanguageServer = extensionConfiguration(SettingsKey.downloadLanguageServer);
  const server = extensionConfiguration(SettingsKey.languageServer);
  const shouldDownload = async (downloadLanguageServer: boolean | "ask"): Promise<boolean> => {
    if (typeof downloadLanguageServer === "boolean") return downloadLanguageServer;

    enum Options {
      yes = "Yes",
      no = "Not this time",
      never = "Never",
    }

    const response = await vscode.window.showInformationMessage(
      "Should the extension try to download the language server?",
      ...Object.values(Options),
    );

    switch (response) {
      case Options.yes:
        extensionConfigurationSet(SettingsKey.downloadLanguageServer, true, vscode.ConfigurationTarget.Global);
        return true;

      case Options.never:
        extensionConfigurationSet(SettingsKey.downloadLanguageServer, false, vscode.ConfigurationTarget.Global);
        return false;

      case Options.no:
        extensionConfigurationSet(SettingsKey.downloadLanguageServer, "ask", vscode.ConfigurationTarget.Global);
        return false;
    }

    return false;
  };

  let client = await createLanguageServerClient(server, await shouldDownload(downloadLanguageServer), ctx);
  if (client !== null && server == "Swift-MesonLSP") {
    ctx.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`mesonbuild.${server}`)) {
          client?.reloadConfig();
        }
      }),
    );

    await client.update(ctx);
    ctx.subscriptions.push(client);
    client.start();
    await client.reloadConfig();

    getOutputChannel().appendLine("Not enabling the muon linter/formatter because Swift-MesonLSP is active.");
  } else {
    activateLinters(root, ctx);
    activateFormatters(root, ctx);
  }

  ctx.subscriptions.push(
    vscode.commands.registerCommand("mesonbuild.restartLanguageServer", async () => {
      if (client === null) {
        client = await createLanguageServerClient(server, await shouldDownload(downloadLanguageServer), ctx);
        if (client !== null) {
          ctx.subscriptions.push(client);
          client.start();
          await client.reloadConfig();
          // TODO: The output line from above about not enabling muon would be good to have here.
        }
      } else {
        await client.restart();
        await client.reloadConfig();
      }
    }),
  );

  async function pickTask(mode: string) {
    const picker = vscode.window.createQuickPick<TaskQuickPickItem>();
    picker.busy = true;
    picker.placeholder = `Select target to ${mode}.`;
    picker.show();

    const runnableTasks = await getTasks(mode);

    picker.busy = false;
    picker.items = runnableTasks.map((task) => {
      return {
        label: task.name,
        detail: task.detail,
        picked: false,
        task: task,
      };
    });

    return new Promise<TaskQuickPickItem>((resolve, reject) => {
      picker.onDidAccept(() => {
        const selection = picker.activeItems[0];
        resolve(selection);
        picker.dispose();
      });
      picker.onDidHide(() => reject());
    });
  }

  async function pickAndRunTask(mode: string, name?: string) {
    if (name) {
      runFirstTask(mode, name);
      return;
    }
    let taskItem;
    try {
      taskItem = await pickTask(mode);
    } catch (err) {
      // Pick cancelled.
    }
    if (taskItem != null) {
      runTask(taskItem.task);
    }
  }
}
