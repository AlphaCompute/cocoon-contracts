import { CompilerConfig } from '@ton/blueprint';

export const compile: CompilerConfig = process.env.USE_FUNC === 'true'
    ? {
        lang: 'func',
        targets: ['contracts/cocoon_root.fc'],
    }
    : {
        lang: 'tolk',
        entrypoint: 'contracts_tolk/cocoon_root.tolk',
    };
