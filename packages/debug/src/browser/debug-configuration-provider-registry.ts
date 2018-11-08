/********************************************************************************
 * Copyright (C) 2018 TypeFox and others.
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

import { injectable, inject } from 'inversify';
import { DebugConfiguration } from '../common/debug-common';
import { DebugConfigurationProvider } from '../common/debug-configuration-provider';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { CancellationToken } from '@theia/core/lib/common/cancellation';
import { Disposable } from '@theia/core/lib/common/disposable';

/**
 * Configuration provider registry.
 * It is supposed to be several configuration providers for the same debug type.
 * For more details see [DebugConfigurationProvider](#DebugConfigurationProvider).
 */
@injectable()
export class DebugConfigurationProviderRegistry {
    protected readonly configurationProviders = new Map<string, DebugConfigurationProvider[]>();

    @inject(WorkspaceService)
    private readonly workspaceService: WorkspaceService;

    registerDebugConfigurationProvider(debugType: string, provider: DebugConfigurationProvider): Disposable {
        const providers = this.configurationProviders.get(debugType) || [];
        providers.push(provider);
        this.configurationProviders.set(debugType, providers);

        return Disposable.create(() => this.unregisterDebugConfigurationProvider(debugType, provider));
    }

    unregisterDebugConfigurationProvider(debugType: string, provider: DebugConfigurationProvider): void {
        let providers = this.configurationProviders.get(debugType) || [];
        providers = providers.filter(item => item !== provider);

        this.configurationProviders.set(debugType, providers);
    }

    /**
     * Finds and returns an array of registered debug types.
     * @returns An array of registered debug types
     */
    debugTypes(): string[] {
        return Array.from(this.configurationProviders.keys());
    }

    /**
     * Provides initial [debug configuration](#DebugConfiguration).
     * @param debugType The registered debug type
     * @param token A cancellation token.
     * @returns An array of [debug configurations](#DebugConfiguration)
     */
    async provideDebugConfigurations(debugType: string, token?: CancellationToken): Promise<DebugConfiguration[]> {
        const allConfigurations: DebugConfiguration[] = [];

        const workspace = this.workspaceService.workspace;
        const folder = workspace ? workspace.uri : undefined;

        const providers = this.configurationProviders.get(debugType) || [];
        for (const provider of providers) {
            if (provider.provideDebugConfigurations) {
                const configurations = await provider.provideDebugConfigurations(folder, token);
                allConfigurations.concat(configurations);
            }
        }

        return allConfigurations;
    }

    /**
     * Resolves a [debug configuration](#DebugConfiguration) by filling in missing values
     * or by adding/changing/removing attributes.
     * @param debugType The registered debug type
     * @param debugConfiguration The [debug configuration](#DebugConfiguration) to resolve.
     * @param token A cancellation token.
     * @returns The resolved debug configuration or undefined.
     */
    async resolveDebugConfiguration(debugType: string, debugConfiguration: DebugConfiguration, token?: CancellationToken): Promise<DebugConfiguration | undefined> {
        const workspace = this.workspaceService.workspace;
        const folder = workspace ? workspace.uri : undefined;

        let resolvedConfiguration = debugConfiguration;

        const providers = this.configurationProviders.get(debugType) || [];
        for (const provider of providers) {
            if (provider.resolveDebugConfiguration) {
                resolvedConfiguration = await provider.resolveDebugConfiguration(folder, resolvedConfiguration, token) || resolvedConfiguration;
            }
        }

        return Promise.resolve(debugConfiguration);
    }
}
