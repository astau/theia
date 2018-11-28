/********************************************************************************
 * Copyright (C) 2018 Red Hat, Inc. and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/
import { Emitter } from '@theia/core/lib/common/event';
import { Disposable } from '../types-impl';
import { Breakpoint } from '../../api/model';
import { RPCProtocol } from '../../api/rpc-protocol';
import {
    PLUGIN_RPC_CONTEXT as Ext,
    DebugMain,
    DebugExt
} from '../../api/plugin-api';
import * as theia from '@theia/plugin';
import uuid = require('uuid');
import { DebugAdapterContribution, DebugAdapterExecutable, CommunicationProvider } from '@theia/debug/lib/node/debug-model';
import { IJSONSchema, IJSONSchemaSnippet } from '@theia/core/lib/common/json-schema';
import { DebuggerDescription } from '@theia/debug/lib/common/debug-service';
import { DebugConfiguration } from '@theia/debug/lib/common/debug-configuration';
import { VSCodeDebugAdapterContribution } from '@theia/debug/lib/node/vscode/vscode-debug-adapter-contribution';
import { DebugProtocol } from 'vscode-debugprotocol';
import { PluginPackageDebuggersContribution } from '../../common';
import { DebugAdapterSessionImpl } from '@theia/debug/lib/node/debug-adapter-session';
import { DisposableCollection } from '@theia/core/lib/common/disposable';
import { IWebSocket } from 'vscode-ws-jsonrpc';
import { ChildProcess, spawn } from 'child_process';
/**
 * It is supposed to work at node.
 */
export class DebugExtImpl implements DebugExt {
    // debug sessions by sessionId
    private debugSessions = new Map<string, PluginDebugSession>();
    private disposables = new Map<string, DisposableCollection>();

    // contributions by contributorId
    private debugAdapterContributions = new Map<string, DebugAdapterContribution>();
    private packageContributions = new Map<string, PluginPackageDebuggersContribution>();

    private proxy: DebugMain;
    private _breakpoints: theia.Breakpoint[] = [];
    private _activeDebugSession: theia.DebugSession | undefined;
    private readonly onDidChangeBreakpointsEmitter = new Emitter<theia.BreakpointsChangeEvent>();
    private readonly onDidChangeActiveDebugSessionEmitter = new Emitter<theia.DebugSession | undefined>();
    private readonly onDidTerminateDebugSessionEmitter = new Emitter<theia.DebugSession>();
    private readonly onDidStartDebugSessionEmitter = new Emitter<theia.DebugSession>();
    private readonly onDidReceiveDebugSessionCustomEmitter = new Emitter<theia.DebugSessionCustomEvent>();

    constructor(rpc: RPCProtocol) {
        this.proxy = rpc.getProxy(Ext.DEBUG_MAIN);
    }

    get onDidReceiveDebugSessionCustomEvent(): theia.Event<theia.DebugSessionCustomEvent> {
        return this.onDidReceiveDebugSessionCustomEmitter.event;
    }

    get onDidChangeActiveDebugSession(): theia.Event<theia.DebugSession | undefined> {
        return this.onDidChangeActiveDebugSessionEmitter.event;
    }

    get onDidTerminateDebugSession(): theia.Event<theia.DebugSession> {
        return this.onDidTerminateDebugSessionEmitter.event;
    }

    get onDidStartDebugSession(): theia.Event<theia.DebugSession> {
        return this.onDidStartDebugSessionEmitter.event;
    }

    get onDidChangeBreakpoints(): theia.Event<theia.BreakpointsChangeEvent> {
        return this.onDidChangeBreakpointsEmitter.event;
    }

    get breakpoints(): theia.Breakpoint[] {
        return this._breakpoints;
    }

    get activeDebugSession(): theia.DebugSession | undefined {
        return this._activeDebugSession;
    }

    get activeDebugConsole(): theia.DebugConsole {
        return {
            append: (value: string) => this.proxy.$appendToDebugConsole(value),
            appendLine: (value: string) => this.proxy.$appendLineToDebugConsole(value)
        };
    }

    addBreakpoints(breakpoints: theia.Breakpoint[]): void {
        this.proxy.$addBreakpoints(breakpoints);
    }

    removeBreakpoints(breakpoints: theia.Breakpoint[]): void {
        this.proxy.$removeBreakpoints(breakpoints);
    }

    startDebugging(folder: theia.WorkspaceFolder | undefined, nameOrConfiguration: string | theia.DebugConfiguration): Thenable<boolean> {
        return Promise.resolve(true);
    }

    registerDebugConfigurationProvider(
        debugType: string,
        provider: theia.DebugConfigurationProvider,
        packageContribution: PluginPackageDebuggersContribution,
        pluginPath: string): Disposable {

        const contributionId = uuid.v4();
        const pluginContribution = new DebugPluginContribution(debugType, provider, pluginPath);
        this.debugAdapterContributions.set(contributionId, pluginContribution);
        this.packageContributions.set(contributionId, packageContribution);

        this.proxy.$registerDebugConfigurationProvider(contributionId, debugType);

        return Disposable.create(() => {
            this.debugAdapterContributions.delete(contributionId);
            this.packageContributions.delete(contributionId);
            this.proxy.$unregisterDebugConfigurationProvider(contributionId);
        });
    }

    $onSessionCustomEvent(sessionId: string, event: string, body?: any): void {
        const session = this.debugSessions.get(sessionId);
        if (session) {
            this.onDidReceiveDebugSessionCustomEmitter.fire({ event, body, session });
        }
    }

    $sessionDidCreate(sessionId: string): void {
        const session = this.debugSessions.get(sessionId);
        if (session) {
            this.onDidStartDebugSessionEmitter.fire(session);
        }
    }

    $sessionDidDestroy(sessionId: string): void {
        const session = this.debugSessions.get(sessionId);
        if (session) {
            this.onDidTerminateDebugSessionEmitter.fire(session);
        }
    }

    $sessionDidChange(sessionId: string | undefined): void {
        const session = sessionId && this.debugSessions.get(sessionId);
        if (session) {
            this.onDidChangeActiveDebugSessionEmitter.fire(session);
        } else {
            this.onDidChangeActiveDebugSessionEmitter.fire(undefined);
        }
    }

    $breakpointsDidChange(all: Breakpoint[], added: Breakpoint[], removed: Breakpoint[], changed: Breakpoint[]): void {
        this._breakpoints = all;
        this.onDidChangeBreakpointsEmitter.fire({ added, removed, changed });
    }

    async $createDebugSession(contributionId: string, debugConfiguration: theia.DebugConfiguration): Promise<string> {
        const adapterContribution = this.debugAdapterContributions.get(contributionId);
        if (adapterContribution) {
            const packageContribution = this.packageContributions.get(contributionId);

            let executable: DebugAdapterExecutable;
            if (packageContribution && packageContribution.adapterExecutableCommand !== undefined) {
                executable = await this.proxy.$executeCommand(packageContribution.adapterExecutableCommand);
            } else if (adapterContribution.provideDebugAdapterExecutable) {
                executable = await adapterContribution.provideDebugAdapterExecutable(debugConfiguration);
            } else {
                throw new Error('It is not possible to provide DebugAdapterExecutable');
            }

            const communicationProvider = startDebugAdapter(executable);

            const sessionId = uuid.v4();
            const session = new PluginDebugSession(sessionId, debugConfiguration, communicationProvider);
            this.debugSessions.set(sessionId, session);

            const disposable = session.onDidReceiveDebugSessionCustomEvent(event => this.onDidReceiveDebugSessionCustomEmitter.fire(event));
            this.disposables.set(sessionId, new DisposableCollection(disposable));
        }

        throw new Error('Debug adapter contribution not found');
    }

    async $terminateDebugSession(sessionId: string): Promise<void> {
        const debugAdapterSession = this.debugSessions.get(sessionId);
        if (debugAdapterSession) {
            this.debugSessions.delete(sessionId);
            this.disposables.get(sessionId)!.dispose();
            this.disposables.delete(sessionId);
            return debugAdapterSession.stop();
        }
    }

    async $getDebuggerDescription(contributionId: string): Promise<DebuggerDescription> {
        const adapterContribution = this.debugAdapterContributions.get(contributionId);
        if (adapterContribution) {
            const label = await adapterContribution.label || adapterContribution.type;
            return { type: adapterContribution.type, label };
        }

        throw new Error('Debug adapter contribution not found');
    }

    async $getSupportedLanguages(contributionId: string): Promise<string[]> {
        const adapterContribution = this.debugAdapterContributions.get(contributionId);
        if (adapterContribution && adapterContribution.languages) {
            const languages = await adapterContribution.languages;
            return languages || [];
        }

        return [];
    }

    async $getSchemaAttributes(contributionId: string): Promise<IJSONSchema[]> {
        const adapterContribution = this.debugAdapterContributions.get(contributionId);
        if (adapterContribution && adapterContribution.getSchemaAttributes) {
            return adapterContribution.getSchemaAttributes();
        }

        return [];
    }

    async $getConfigurationSnippets(contributionId: string): Promise<IJSONSchemaSnippet[]> {
        const adapterContribution = this.debugAdapterContributions.get(contributionId);
        if (adapterContribution && adapterContribution.getConfigurationSnippets) {
            return adapterContribution.getConfigurationSnippets();
        }

        return [];
    }

    async $provideDebugConfigurations(contributionId: string, folder: string | undefined): Promise<theia.DebugConfiguration[]> {
        const adapterContribution = this.debugAdapterContributions.get(contributionId);
        if (adapterContribution && adapterContribution.provideDebugConfigurations) {
            const result = await adapterContribution.provideDebugConfigurations(undefined);
            if (result) {
                return result;
            }
        }

        return [];
    }

    async $resolveDebugConfigurations(
        contributionId: string,
        debugConfiguration: theia.DebugConfiguration,
        folder: string | undefined): Promise<theia.DebugConfiguration | undefined> {

        const adapterContribution = this.debugAdapterContributions.get(contributionId);
        if (adapterContribution && adapterContribution.resolveDebugConfiguration) {
            return adapterContribution.resolveDebugConfiguration(debugConfiguration, folder);
        }

        return undefined;
    }
}

class DebugPluginContribution extends VSCodeDebugAdapterContribution {
    protected readonly provider: theia.DebugConfigurationProvider;

    constructor(debugType: string, provider: theia.DebugConfigurationProvider, pluginPath: string) {
        super(debugType, pluginPath);
        this.provider = provider;
    }

    async provideDebugConfigurations(workspaceFolderUri?: string): Promise<DebugConfiguration[]> {
        if (this.provider.provideDebugConfigurations) {
            // TODO convert to WorkspaceFolder
            const result = await this.provider.provideDebugConfigurations(undefined);
            if (result) {
                return result;
            }
        }

        return [];
    }

    async resolveDebugConfiguration(config: DebugConfiguration, workspaceFolderUri?: string): Promise<DebugConfiguration | undefined> {
        if (this.provider.resolveDebugConfiguration) {
            // TODO convert to WorkspaceFolder
            return this.provider.resolveDebugConfiguration(undefined, config);
        }

        return undefined;
    }
}

class PluginDebugSession extends DebugAdapterSessionImpl implements theia.DebugSession {
    readonly type: string;
    readonly name: string;

    seq = 1000000;

    private readonly onDidReceiveDebugSessionCustomEmitter = new Emitter<theia.DebugSessionCustomEvent>();
    get onDidReceiveDebugSessionCustomEvent(): theia.Event<theia.DebugSessionCustomEvent> {
        return this.onDidReceiveDebugSessionCustomEmitter.event;
    }

    constructor(
        readonly id: string,
        readonly configuration: theia.DebugConfiguration,
        readonly communicationProvider: CommunicationProvider) {

        super(id, communicationProvider);

        this.type = configuration.type;
        this.name = configuration.name;
    }

    async start(channel: IWebSocket): Promise<void> {
        super.start(channel);
    }

    protected send(message: string): void {
        const protocolMessage = JSON.parse(message) as DebugProtocol.ProtocolMessage;
        if (protocolMessage.type === 'event') {
            const event = protocolMessage as DebugProtocol.Event;
            this.onDidReceiveDebugSessionCustomEmitter.fire({ session: this, ...event });
        }

        super.send(message);
    }

    async customRequest(command: string, args?: any): Promise<any> {
        const request: DebugProtocol.Request = {
            type: 'request',
            seq: this.seq++,
            command,
            arguments: args
        };

        super.write(JSON.stringify(request));
    }
}

function startDebugAdapter(executable: DebugAdapterExecutable): CommunicationProvider {
    const { command, args } = executable;
    const childProcess = spawn(command, args, { stdio: ['pipe', 'pipe', 2] }) as ChildProcess;

    return {
        input: childProcess.stdin,
        output: childProcess.stdout,
        dispose: () => childProcess.kill()
    };
}
