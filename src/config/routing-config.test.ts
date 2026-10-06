import {describe, expect, it} from 'vitest';
import {normalizeRoutingConfig} from './routing-config.js';
import type {RoutingConfig} from '../contracts/routing.js';

describe('routing configuration',()=>{
 it('keeps existing profiles on Standard without requiring a Jev credential',()=>{
  expect(normalizeRoutingConfig(undefined)).toEqual({mode:'standard',jev:{provider:'typesafe',id:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY',timeoutMs:5000}});
 });
 it('retains the configured model and credential reference when switched off',()=>{
  expect(normalizeRoutingConfig({mode:'standard',jev:{id:'jev-preview',apiKeyEnv:'MY_ROUTING_KEY',timeoutMs:9000}})).toMatchObject({mode:'standard',jev:{id:'jev-preview',apiKeyEnv:'MY_ROUTING_KEY',timeoutMs:9000}});
 });
 it.each([null,[],{mode:'shadow'},{jev:[]},{jev:{provider:'openai'}},{jev:{id:'https://untrusted.test'}},{jev:{apiKeyEnv:'secret-value'}},{jev:{timeoutMs:0}},{jev:{timeoutMs:60001}},{jev:{timeoutMs:1.5}}])('rejects invalid configuration without echoing input %#',value=>{
  expect(()=>normalizeRoutingConfig(value as RoutingConfig)).toThrow(/routing/);
 });
});
