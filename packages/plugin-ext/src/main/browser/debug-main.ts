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

import { interfaces } from 'inversify';
import { RPCProtocol } from '../../api/rpc-protocol';
import {
    DebugMain,
    DebugExt,
    MAIN_RPC_CONTEXT
} from '../../api/plugin-api';
import { DebugSessionManager } from '@theia/debug/lib/browser/debug-session-manager';
import { Breakpoint } from '../../api/model';
import { LabelProvider } from '@theia/core/lib/browser';
import { EditorManager } from '@theia/editor/lib/browser';
import { BreakpointManager } from '@theia/debug/lib/browser/breakpoint/breakpoint-manager';
import { DebugBreakpoint } from '@theia/debug/lib/browser/model/debug-breakpoint';
import URI from 'vscode-uri';
import { DebugConsoleSession } from '@theia/debug/lib/browser/console/debug-console-session';
import { SourceBreakpoint } from '@theia/debug/lib/browser/breakpoint/breakpoint-marker';
import { DebugPluginContributor, DebugContributionManager } from '@theia/debug/lib/browser/debug-contribution-manager';
import { PluginPackageDebuggersContribution } from '../../common';
import { DebugConfiguration } from '@theia/debug/lib/common/debug-configuration';
import { toJSONSchema } from '@theia/debug/lib/common/vscode/vscode-debug-adapter-contribution';

export class DebugMainImpl implements DebugMain {
    private readonly proxy: DebugExt;
    private readonly sessionManager: DebugSessionManager;
    private readonly labelProvider: LabelProvider;
    private readonly editorManager: EditorManager;
    private readonly breakpointsManager: BreakpointManager;
    private readonly debugConsoleSession: DebugConsoleSession;
    private readonly proxyContributors = new Map<string, DebugPluginContributor>();
    private readonly contributionManager: DebugContributionManager;

    constructor(rpc: RPCProtocol, container: interfaces.Container) {
        this.proxy = rpc.getProxy(MAIN_RPC_CONTEXT.DEBUG_EXT);
        this.contributionManager = container.get(DebugContributionManager);
        this.sessionManager = container.get(DebugSessionManager);
        this.labelProvider = container.get(LabelProvider);
        this.editorManager = container.get(EditorManager);
        this.breakpointsManager = container.get(BreakpointManager);
        this.debugConsoleSession = container.get(DebugConsoleSession);

        // TODO: distinguish added/deleted breakpoints
        this.breakpointsManager.onDidChangeMarkers(uri => {
            const all = this.breakpointsManager.getBreakpoints();
            const affected = this.breakpointsManager.getBreakpoints(uri);
            this.proxy.$breakpointsDidChange(this.toTheiaPluginApiBreakpoints(all), [], [], this.toTheiaPluginApiBreakpoints(affected));
        });

        this.sessionManager.onDidCreateDebugSession(debugSession => this.proxy.$sessionDidCreate(debugSession.id, debugSession.configuration));
        this.sessionManager.onDidDestroyDebugSession(debugSession => this.proxy.$sessionDidDestroy(debugSession.id, debugSession.configuration));
        this.sessionManager.onDidChangeActiveDebugSession(event => {
            const sessionId = event.current && event.current.id;
            const configuration = event.current && event.current.configuration;
            this.proxy.$sessionDidChange(sessionId, configuration);
        });
    }

    $appendToDebugConsole(value: string): void {
        this.debugConsoleSession.append(value);
    }

    $appendLineToDebugConsole(value: string): void {
        this.debugConsoleSession.appendLine(value);
    }

    $registerDebugConfigurationProvider(contributorId: string, contribution: PluginPackageDebuggersContribution): void {
        const proxyContributor: DebugPluginContributor = {
            description: {
                type: contribution.type,
                label: contribution.label
            },
            getSupportedLanguages: () => Promise.resolve(contribution.languages),
            getSchemaAttributes: () => Promise.resolve(toJSONSchema(contribution.type, contribution.configurationAttributes)),
            getConfigurationSnippets: () => Promise.resolve(contribution.configurationSnippets),

            provideDebugConfigurations: (workspaceFolderUri: string | undefined) =>
                this.proxy.$provideDebugConfigurations(contributorId, workspaceFolderUri),

            resolveDebugConfiguration: (config: DebugConfiguration, workspaceFolderUri: string | undefined) =>
                this.proxy.$resolveDebugConfigurations(contributorId, config, workspaceFolderUri),

            createDebugSession: (config: DebugConfiguration) => Promise.resolve(''),
            terminateDebugSession: () => Promise.resolve(undefined)
        };

        this.proxyContributors.set(contributorId, proxyContributor);
        this.contributionManager.registerDebugPluginContributor(proxyContributor);
    }

    $unregisterDebugConfigurationProvider(contributorId: string): void {
        const contributor = this.proxyContributors.get(contributorId);
        if (contributor) {
            this.contributionManager.unregisterDebugPluginContributor(contributor.description.type);
            this.proxyContributors.delete(contributorId);
        }
    }

    $addBreakpoints(breakpoints: Breakpoint[]): void {
        this.sessionManager.addBreakpoints(this.toInternalBreakpoints(breakpoints));
    }

    $removeBreakpoints(breakpoints: Breakpoint[]): void {
        this.sessionManager.removeBreakpoints(this.toInternalBreakpoints(breakpoints));
    }

    private toInternalBreakpoints(breakpoints: Breakpoint[]): DebugBreakpoint[] {
        return breakpoints
            .filter(breakpoint => !!breakpoint.location)
            .map(breakpoint => {
                const location = breakpoint.location!;
                const uri = URI.revive(location.uri);
                const uriString = uri.toString();

                const origin = {
                    uri: uriString,
                    enabled: true,
                    raw: {
                        line: location.range.startLineNumber,
                        column: location.range.startColumn,
                        condition: breakpoint.condition,
                        hitCondition: breakpoint.hitCondition,
                        logMessage: breakpoint.logMessage
                    }
                };

                return new DebugBreakpoint(origin,
                    this.labelProvider,
                    this.breakpointsManager,
                    this.editorManager,
                    this.sessionManager.currentSession);
            });
    }

    private toTheiaPluginApiBreakpoints(sourceBreakpoints: SourceBreakpoint[]): Breakpoint[] {
        return sourceBreakpoints.map(b => {
            const breakpoint = {
                enabled: b.enabled,
                condition: b.raw.condition,
                hitCondition: b.raw.hitCondition,
                logMessage: b.raw.logMessage,
                location: {
                    uri: URI.revive(b.uri),
                    range: {
                        startLineNumber: b.raw.line,
                        startColumn: b.raw.column || 0,
                        endLineNumber: b.raw.line,
                        endColumn: b.raw.column || 0
                    }
                }
            };

            return breakpoint;
        });
    }
}
