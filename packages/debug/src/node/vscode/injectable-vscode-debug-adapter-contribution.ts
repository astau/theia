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

import { DebugAdapterExecutable, DebugAdapterContribution } from '../../debug-model';
import { IJSONSchema, IJSONSchemaSnippet } from '@theia/core/lib/common/json-schema';
import { injectable, unmanaged } from 'inversify';
import { VSCodeDebugAdapterContribution } from '../vscode-debug-adapter-contribution';

// TODO move to @theia/debug
@injectable()
export class AbstractVSCodeDebugAdapterContribution implements DebugAdapterContribution {
    private readonly delegated: VSCodeDebugAdapterContribution;
    constructor(
        @unmanaged() readonly type: string,
        @unmanaged() readonly extensionPath: string) {
        this.delegated = new VSCodeDebugAdapterContribution(type, extensionPath);
    }

    get label(): Promise<string | undefined> {
        return this.delegated.label;
    }

    get languages(): Promise<string[] | undefined> {
        return this.delegated.languages;
    }

    async getSchemaAttributes(): Promise<IJSONSchema[]> {
        return this.delegated.getSchemaAttributes();
    }

    async getConfigurationSnippets?(): Promise<IJSONSchemaSnippet[]> {
        return this.delegated.getConfigurationSnippets();
    }

    async provideDebugAdapterExecutable(): Promise<DebugAdapterExecutable> {
        return this.delegated.provideDebugAdapterExecutable();
    }
}
