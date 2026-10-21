import test from 'node:test';
import assert from 'node:assert/strict';
import { imagePoint } from '../scripts/renderer/imageEditCanvas.js';
test('mask coordinates stay in original pixels under zoom and scroll', () => {
    assert.deepEqual(imagePoint({clientX:300,clientY:200},{left:100,top:100,width:400,height:200},800,400),{x:400,y:200});
    assert.deepEqual(imagePoint({clientX:300,clientY:200},{left:-100,top:0,width:800,height:400},800,400),{x:400,y:200});
    assert.deepEqual(imagePoint({clientX:-5,clientY:999},{left:0,top:0,width:100,height:100},100,100),{x:0,y:99});
});
