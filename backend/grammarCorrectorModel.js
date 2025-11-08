/**
 * Grammar Corrector - Using Hugging Face Model
 * Uses @xenova/transformers with onnx-community/grammar-synthesis-small-ONNX
 * T5-based text2text-generation model for grammar correction
 * 
 * Model: https://huggingface.co/onnx-community/grammar-synthesis-small-ONNX
 * Size: Properly formatted for Transformers.js - designed for Node.js compatibility
 * 
 * ⚠️ COMPATIBILITY NOTE:
 * This file includes targeted patches for Xenova Transformers.js generation bugs:
 * - Fixed: "Cannot set properties of undefined" in LogitsProcessor._call (generation.js:451)
 * - Fixed: Tensor.data undefined when logits processors try to modify it
 * - Patches applied via xenova-fix.js after model loading
 * 
 * FALLBACK: If patches fail, set HF_TOKEN env variable to use HuggingFace API
 * OR: Set ENABLE_XENOVA_GRAMMAR=false to use rule-based corrections only
 */

import { pipeline, AutoModelForSeq2SeqLM, AutoTokenizer } from '@xenova/transformers';
import fetch from 'node-fetch';
import { patchXenovaGeneration } from './xenova-fix.js';

// CRITICAL FIX: Patch Tensor._subarray to handle undefined data bug
// This fixes the "Cannot use 'in' operator to search for 'subarray' in undefined" error
// The bug is in seq2seqStartBeams when it iterates over tokens with undefined data
let tensorPatched = false;

async function patchTensorSubarray() {
  if (tensorPatched) return;
  
  try {
    // Import Tensor from the transformers library
    const transformersModule = await import('@xenova/transformers');
    const Tensor = transformersModule.Tensor;
    
    if (Tensor && Tensor.prototype) {
      // CRITICAL PATCH: Also need to patch ONNX Runtime's Tensor constructor if it exists
      // The Tensor constructor might be clearing the data property
      try {
        // Try multiple possible ONNX import paths
        let onnxCommon = null;
        try {
          onnxCommon = await import('onnxruntime-common');
        } catch (e1) {
          try {
            const onnxNode = await import('onnxruntime-node');
            onnxCommon = onnxNode;
          } catch (e2) {
            console.log('[GrammarCorrector] ONNX Runtime not found in onnxruntime-common or onnxruntime-node');
          }
        }
        
        if (onnxCommon && onnxCommon.Tensor) {
          const OriginalTensor = onnxCommon.Tensor;
          onnxCommon.Tensor = class extends OriginalTensor {
            constructor(type, data, dims, location = 'cpu') {
              super(type, data, dims, location);
              // Ensure dataLocation is always a string (location is a getter, read-only)
              if (this.dataLocation && typeof this.dataLocation !== 'string') {
                this.dataLocation = String(this.dataLocation);
              }
              // CRITICAL: Ensure data is preserved by setting it directly on the instance
              // Object.assign in transformers will overwrite our data, so we need to set it here
              if (data) {
                // Force set data property
                try {
                  Object.defineProperty(this, 'data', {
                    value: data,
                    writable: true,
                    enumerable: true,
                    configurable: true
                  });
                } catch (e) {
                  // If defineProperty fails, try direct assignment
                  console.warn('[GrammarCorrector] defineProperty failed, trying direct assignment:', e.message);
                  this.data = data;
                }
              }
            }
          };
          console.log('[GrammarCorrector] ✅ Patched ONNX Runtime Tensor constructor');
        }
      } catch (e) {
        // ONNX Runtime might not be importable this way
        console.log('[GrammarCorrector] ONNX Runtime Tensor not patchable:', e.message);
      }
      
      // Patch _subarray method (first bug)
      if (Tensor.prototype._subarray) {
        const originalSubarray = Tensor.prototype._subarray;
        
        Tensor.prototype._subarray = function(index, iterSize, iterDims) {
          // Check if data exists before using 'in' operator (this is the bug fix)
          if (!this.data || this.data === undefined || this.data === null) {
            // CRITICAL: Try to use cpuData first if available, rather than creating empty tensor
            if (this.cpuData && this.cpuData.length > 0) {
              // Calculate the slice range
              const endIndex = Math.min(index + iterSize, this.cpuData.length);
              const sliceLength = Math.max(0, endIndex - index);
              
              // Create slice from cpuData
              let sliceData;
              const tensorType = this.type || 'float32';
              
              if (tensorType === 'int64' && this.cpuData instanceof BigInt64Array) {
                sliceData = this.cpuData.slice(index, endIndex);
              } else if (this.cpuData.slice) {
                sliceData = this.cpuData.slice(index, endIndex);
              } else {
                // Fallback: convert to array and slice
                const arr = Array.from(this.cpuData).slice(index, endIndex);
                if (tensorType === 'int64') {
                  sliceData = new BigInt64Array(arr.map(x => BigInt(x)));
                } else {
                  sliceData = new (this.cpuData.constructor || Float32Array)(arr);
                }
              }
              
              // Calculate dims from slice
              const dims = iterDims || [1, sliceLength];
              return new Tensor(tensorType, sliceData, dims);
            }
            
            // Fallback: Return a minimal valid tensor to avoid crash
            // CRITICAL: Preserve the tensor type - use BigInt64Array for int64, etc.
            // CRITICAL: Calculate size from iterDims to match Tensor constructor requirements
            const tensorType = this.type || 'float32';
            const dims = iterDims || (this.dims ? [this.dims[0], iterSize || 1] : [1, 1]);
            const requiredSize = dims.length > 0 ? dims.reduce((a, b) => a * b, 1) : (iterSize || 1);
            
            let emptyData;
            if (tensorType === 'int64') {
              emptyData = new BigInt64Array(requiredSize);
            } else if (this.cpuData && this.cpuData.constructor) {
              // Try to use the same constructor as cpuData
              emptyData = new this.cpuData.constructor(requiredSize);
            } else {
              // Fallback based on type
              if (tensorType === 'float32') {
                emptyData = new Float32Array(requiredSize);
              } else if (tensorType === 'int32') {
                emptyData = new Int32Array(requiredSize);
              } else {
                emptyData = new Float32Array(requiredSize);
              }
            }
            
            return new Tensor(tensorType, emptyData, dims);
          }
          // Call original method if data exists - it should preserve the data type
          const result = originalSubarray.call(this, index, iterSize, iterDims);
          
          // CRITICAL: Ensure the result tensor has the correct data type for int64
          // ONNX Runtime requires BigInt64Array for int64 tensors
          if (this.type === 'int64' && result) {
            if (result.data && !(result.data instanceof BigInt64Array)) {
              // If the result doesn't have BigInt64Array, fix it
              const bigIntData = Array.from(result.data).map(x => BigInt(x));
              result.data = new BigInt64Array(bigIntData);
              // Also set cpuData
              if (!result.cpuData) {
                result.cpuData = result.data;
              }
              console.log('[GrammarCorrector] Fixed _subarray result to use BigInt64Array');
            } else if (!result.data && this.cpuData instanceof BigInt64Array) {
              // If result has no data but we have cpuData, create a slice
              try {
                const slice = this.cpuData.subarray(index, index + iterSize);
                result.data = slice;
                result.cpuData = slice;
              } catch (e) {
                console.warn('[GrammarCorrector] Could not create subarray from cpuData:', e.message);
              }
            }
            
            // Ensure dataLocation is set for ONNX Runtime (location is a getter, read-only)
            if (!result.dataLocation) {
              result.dataLocation = this.dataLocation || 'cpu';
            }
          }
          
          return result;
        };
      }
      
      // Patch indexOf method (second bug - "Cannot read properties of undefined (reading 'length')")
      if (Tensor.prototype.indexOf) {
        const originalIndexOf = Tensor.prototype.indexOf;
        
        Tensor.prototype.indexOf = function(searchElement, fromIndex) {
          // Check if data exists before accessing length
          if (!this.data || this.data === undefined || this.data === null) {
            console.warn('[GrammarCorrector] Tensor.indexOf called with undefined data, returning -1');
            return -1; // Standard indexOf behavior when not found
          }
          // Ensure data has length property
          if (typeof this.data.length === 'undefined') {
            console.warn('[GrammarCorrector] Tensor data has no length property, returning -1');
            return -1;
          }
          // Call original method if data is valid
          return originalIndexOf.call(this, searchElement, fromIndex);
        };
      }
      
      // CRITICAL PATCH: Add location getter to transformers Tensor
      // Object.assign doesn't copy getter properties from ONNXTensor
      if (!Tensor.prototype.hasOwnProperty('location')) {
        Object.defineProperty(Tensor.prototype, 'location', {
          get: function() {
            return this.dataLocation;
          },
          enumerable: false,
          configurable: true
        });
        console.log('[GrammarCorrector] ✅ Added location getter to Tensor');
      }
      
      tensorPatched = true;
      console.log('[GrammarCorrector] ✅ Patched Tensor._subarray, Tensor.indexOf, and added location getter');
    }
  } catch (error) {
    console.warn('[GrammarCorrector] Could not patch Tensor methods:', error.message);
  }
}

export class GrammarCorrectorModel {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.language = options.language || 'en-US';
    // Use onnx-community model - specifically designed for Transformers.js
    this.modelName = options.modelName || process.env.GRAMMAR_MODEL || 'onnx-community/grammar-synthesis-small-ONNX';
    this.originalModelName = 'onnx-community/grammar-synthesis-small-ONNX'; // For API fallback
    
    // Pipeline will be initialized lazily
    this.pipeline = null;
    this.initializing = false;
    this.initPromise = null;
    this.useAPI = false; // Fallback to API if local model fails
    this.apiUrl = `https://api-inference.huggingface.co/models/${this.originalModelName}`;
    this.hfToken = process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN;
    
    // Status tracking
    this.status = 'not_initialized'; // not_initialized, downloading, loading, ready, failed
    this.initStartTime = null;
    this.downloadProgress = null;
  }
  
  /**
   * Get current status of the grammar corrector
   */
  getStatus() {
    return {
      status: this.status,
      pipeline: !!this.pipeline,
      initializing: this.initializing,
      useAPI: this.useAPI,
      modelName: this.modelName,
      elapsed: this.initStartTime ? Date.now() - this.initStartTime : null
    };
  }

  /**
   * Initialize the model pipeline
   */
  async init() {
    if (this.pipeline) return;
    if (this.initializing) return this.initPromise;
    if (!this.enabled) return;

    // Apply Tensor patch early to prevent bugs
    await patchTensorSubarray();

    this.initializing = true;
    this.status = 'downloading';
    this.initStartTime = Date.now();
    
    // Start periodic status updates
    const statusInterval = setInterval(() => {
      if (!this.initializing) {
        clearInterval(statusInterval);
        return;
      }
      const elapsed = Math.floor((Date.now() - this.initStartTime) / 1000);
      console.log(`[GrammarCorrector] ⏳ Status: ${this.status.toUpperCase()} (${elapsed}s elapsed) - Still loading...`);
    }, 5000); // Update every 5 seconds
    
    this.initPromise = (async () => {
      try {
        console.log(`[GrammarCorrector] ⏳ Initializing grammar correction model: ${this.modelName}...`);
        console.log('[GrammarCorrector] 📦 Status: DOWNLOADING - Model files (~77MB)...');
        console.log('[GrammarCorrector] 💡 This is a one-time download. Subsequent starts will be faster.');
        
        try {
          // Create text2text-generation pipeline
          // Try Xenova version first (pre-converted for Transformers.js)
          // If that fails, try the original pszemraj version
          let modelToTry = this.modelName;
          
            try {
              console.log(`[GrammarCorrector] 📥 Loading model: ${modelToTry}...`);
              this.status = 'loading';
              console.log('[GrammarCorrector] 📋 Status: LOADING - Processing model files...');
              
              // Skip standard pipeline by default - it has a bug in seq2seqStartBeams
              const skipStandardPipeline = process.env.GRAMMAR_USE_STANDARD_PIPELINE !== 'true';
              
              if (!skipStandardPipeline) {
              try {
                  const rawPipeline = await pipeline(
                  'text2text-generation',
                  modelToTry,
                  {
                    quantized: true,
                  }
                );
                  
                  // Wrap the pipeline to catch internal errors (like 'subarray' errors)
                  // If we get the subarray error, we'll switch to direct model loading
                  this.pipeline = async (text, options = {}) => {
                    try {
                      // Ensure text is a string (not pre-tokenized)
                      if (typeof text !== 'string') {
                        throw new Error('Input must be a string');
                      }
                      
                      // Normalize options to avoid beam search bugs
                      const safeOptions = {
                        max_new_tokens: options.max_new_tokens || 256,
                        do_sample: false, // Force greedy decoding
                        ...(options.num_beams === 1 ? {} : { num_beams: 1 }), // Force single beam
                      };
                      
                      return await rawPipeline(text, safeOptions);
                    } catch (error) {
                      // Catch 'subarray' errors from within the library
                      if (error && error.message && error.message.includes('subarray')) {
                        console.error('[GrammarCorrector] ⚠️ Standard pipeline has seq2seqStartBeams bug - switching to direct model loading');
                        console.error('[GrammarCorrector] Error: Cannot use \'in\' operator to search for \'subarray\' in undefined');
                        
                        // Mark that pipeline is broken and trigger switch to direct loading
                        this._pipelineHasBug = true;
                        this.pipeline = null; // Clear the broken pipeline
                        this.status = 'loading'; // Mark as loading so we'll retry
                        
                        // Return original text for this call
                        return [{ generated_text: text }];
                      }
                      throw error;
                    }
                  };
                  
                console.log(`[GrammarCorrector] ✅ Pipeline loaded successfully: ${modelToTry}`);
                this.status = 'ready';
                this.useAPI = false;
                  this._pipelineHasBug = false; // Reset bug flag if pipeline loads successfully
              } catch (pipelineError) {
                  // If pipeline fails, try loading model and tokenizer directly
                  // visheratin model has proper ONNX exports
                  if (skipStandardPipeline || this._pipelineHasBug || modelToTry === this.originalModelName) {
                    console.log(`[GrammarCorrector] 🔄 Pipeline failed or skipped, trying direct model loading...`);
                console.log('[GrammarCorrector] 📋 Status: LOADING - Loading tokenizer and model separately...');
                    
                    // Use the configured model for direct loading - it has proper ONNX exports
                    const directModelName = modelToTry;
                    console.log(`[GrammarCorrector] 🔄 Using ${directModelName} for direct loading (ONNX format)`);
                
                // Load tokenizer and model separately
                console.log('[GrammarCorrector] 🔤 Loading tokenizer...');
                    const tokenizer = await Promise.race([
                      AutoTokenizer.from_pretrained(directModelName),
                      new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Tokenizer load timeout after 60s')), 60000)
                      )
                    ]);
                console.log('[GrammarCorrector] 🧠 Loading model weights...');
                    const model = await Promise.race([
                      AutoModelForSeq2SeqLM.from_pretrained(directModelName, {
                        quantized: true, // Use quantized for faster loading
                      }),
                      new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Model load timeout after 120s')), 120000)
                      )
                    ]);
                
                // CRITICAL: Patch Xenova generation bug BEFORE using model
                await patchXenovaGeneration();
                
                // Create a pipeline-like wrapper
                this.pipeline = async (text, options = {}) => {
                      try {
                        // Tokenize with proper options for @xenova/transformers
                        // Note: @xenova/transformers uses different options than Python transformers
                  const inputs = await tokenizer(text);
                        
                        // Validate inputs structure
                        if (!inputs) {
                          throw new Error('Tokenizer returned undefined');
                        }
                        
                        // CRITICAL FIX: Ensure Tensor objects have data property set from cpuData
                        // The tokenizer returns tensors with cpuData but data is undefined
                        // We need to set data from cpuData before using them
                        if (inputs && inputs.input_ids && inputs.input_ids.cpuData && inputs.input_ids.data === undefined) {
                          inputs.input_ids.data = inputs.input_ids.cpuData;
                        }
                        if (inputs && inputs.attention_mask && inputs.attention_mask.cpuData && inputs.attention_mask.data === undefined) {
                          inputs.attention_mask.data = inputs.attention_mask.cpuData;
                        }
                        
                        // Handle different tokenizer output formats from @xenova/transformers
                        let inputIds;
                        if (inputs && inputs.input_ids) {
                          const inputIdsValue = inputs.input_ids;
                          // Use the tensor directly (we've already fixed the data property)
                          // Make sure it's actually a Tensor, not an object wrapper
                          if (inputIdsValue && typeof inputIdsValue === 'object') {
                            inputIds = inputIdsValue;
                          } else {
                            inputIds = inputIdsValue;
                          }
                        } else if (Array.isArray(inputs)) {
                          inputIds = inputs[0] || inputs;
                        } else if (inputs && inputs.data) {
                          inputIds = inputs.data;
                        } else {
                          inputIds = inputs;
                        }
                        
                        if (!inputIds) {
                          throw new Error('Could not extract input_ids from tokenizer output');
                        }
                        
                        // Generate with model
                        const outputs = await model.generate(inputIds, {
                    max_new_tokens: options.max_new_tokens || 256,
                    num_beams: options.num_beams || 1,
                    early_stopping: options.early_stopping !== false,
                    do_sample: options.do_sample || false,
                    temperature: options.temperature || 1.0,
                  });
                        
                        // Handle different output formats from model.generate
                        // model.generate typically returns the token IDs directly or wrapped in an object
                        let outputIds = null;
                        
                        try {
                          // Try to extract token IDs from various possible formats
                          if (Array.isArray(outputs)) {
                            // If it's an array, take the first element (sequence)
                            outputIds = outputs[0];
                            // If first element is also an array or has data, extract further
                            if (outputIds && typeof outputIds === 'object' && outputIds.data) {
                              outputIds = outputIds.data;
                            }
                          } else if (outputs && typeof outputs === 'object') {
                            // Check for common property names
                            if (outputs.sequences !== undefined && outputs.sequences !== null) {
                              const seq = Array.isArray(outputs.sequences) ? outputs.sequences[0] : outputs.sequences;
                              if (seq && seq.data !== undefined) {
                                outputIds = seq.data;
                              } else if (seq) {
                                outputIds = seq;
                              }
                            } else if (outputs.input_ids !== undefined && outputs.input_ids !== null) {
                              const ids = outputs.input_ids;
                              if (ids.data !== undefined) {
                                outputIds = ids.data;
                              } else {
                                outputIds = ids;
                              }
                            } else if (outputs[0] !== undefined) {
                              outputIds = outputs[0];
                            } else if (outputs.data !== undefined) {
                              outputIds = outputs.data;
                            } else {
                              // Use the object itself - might be a Tensor
                              outputIds = outputs;
                            }
                          } else {
                            outputIds = outputs;
                          }
                          
                          // Convert to plain array if needed to avoid 'subarray' errors
                          if (outputIds && typeof outputIds === 'object' && outputIds !== null) {
                            // If it's a TypedArray or similar, convert to regular array
                            if (!Array.isArray(outputIds)) {
                              // Check if it has length property (TypedArray-like)
                              if ('length' in outputIds && typeof outputIds.length === 'number') {
                                try {
                                  // Convert TypedArray to regular array
                                  outputIds = Array.from(outputIds);
                                } catch (convertError) {
                                  // If conversion fails, try using subarray (but safely)
                                  if ('subarray' in outputIds && typeof outputIds.subarray === 'function') {
                                    outputIds = outputIds.subarray(0);
                                  }
                                }
                              }
                            }
                          }
                          
                          if (!outputIds || (Array.isArray(outputIds) && outputIds.length === 0)) {
                            throw new Error('Could not extract valid token IDs from model.generate output');
                          }
                          
                          // tokenizer.decode expects an array or tensor-like object
                          // Pass it directly - tokenizer should handle the conversion
                          const decoded = await tokenizer.decode(outputIds, { skip_special_tokens: true });
                  return [{ generated_text: decoded }];
                        } catch (decodeError) {
                          // If decode fails, log the error and the output format for debugging
                          console.error('[GrammarCorrector] Decode error:', decodeError.message);
                          console.error('[GrammarCorrector] Output type:', typeof outputs);
                          console.error('[GrammarCorrector] Output isArray:', Array.isArray(outputs));
                          if (outputs && typeof outputs === 'object') {
                            console.error('[GrammarCorrector] Output keys:', Object.keys(outputs));
                          }
                          throw decodeError;
                        }
                      } catch (error) {
                        console.error('[GrammarCorrector] Pipeline wrapper error:', error.message);
                        console.error('[GrammarCorrector] Error stack:', error.stack);
                        throw error;
                      }
                    };
                    
                    console.log(`[GrammarCorrector] ✅ Direct model loaded: ${directModelName}`);
                this.status = 'ready';
                this.useAPI = false;
              } else {
                throw pipelineError;
              }
                }
              } else {
                // Standard pipeline was skipped - go directly to model loading
                // Use the configured model which has ONNX files
                const directModelName = this.modelName;
                console.log(`[GrammarCorrector] 🔄 Pipeline skipped, using direct model loading with ${directModelName}...`);
                console.log('[GrammarCorrector] 📋 Status: LOADING - Loading tokenizer and model separately...');
                
                // Load tokenizer and model separately
                console.log('[GrammarCorrector] 🔤 Loading tokenizer...');
                const tokenizer = await Promise.race([
                  AutoTokenizer.from_pretrained(directModelName),
                  new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Tokenizer load timeout after 60s')), 60000)
                  )
                ]);
                console.log('[GrammarCorrector] 🧠 Loading model weights...');
                const model = await Promise.race([
                  AutoModelForSeq2SeqLM.from_pretrained(directModelName, {
                    quantized: true, // Use quantized for faster loading
                  }),
                  new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Model load timeout after 120s')), 120000)
                  )
                ]);
                
                // CRITICAL: Patch Xenova generation bug BEFORE using model
                await patchXenovaGeneration();
                
                // Create a pipeline-like wrapper
                this.pipeline = async (text, options = {}) => {
                  try {
                    // Tokenize with proper options for @xenova/transformers
                    // Note: @xenova/transformers uses different options than Python transformers
                  const inputs = await tokenizer(text);
                    
                    // Validate inputs structure
                    if (!inputs) {
                      throw new Error('Tokenizer returned undefined');
                    }
                    
                    // CRITICAL FIX: Work directly with inputs.input_ids Tensor
                    // The Tensor has cpuData but data is undefined - we MUST fix this BEFORE doing anything else
                    // ONNX Runtime requires the data property to be set
                    const { Tensor } = await import('@xenova/transformers');
                    
                    // Get the input_ids Tensor directly - don't extract data yet
                    let inputIdsTensor = null;
                    if (inputs && inputs.input_ids) {
                      inputIdsTensor = inputs.input_ids;
                    } else if (Array.isArray(inputs)) {
                      inputIdsTensor = inputs[0];
                    } else {
                      inputIdsTensor = inputs;
                    }
                    
                    if (!inputIdsTensor) {
                      throw new Error('Could not get input_ids from tokenizer output');
                    }
                    
                    // CRITICAL FIX: Fix BOTH input_ids AND attention_mask
                    // model.generate() uses both tensors, and both need data/location properties
                    const fixTensor = (tensor, name = 'tensor') => {
                      console.log(`[GrammarCorrector] 🔧 Fixing ${name}...`);
                      if (!(tensor instanceof Tensor)) {
                        console.log(`[GrammarCorrector] ⚠️ ${name} is not a Tensor instance, returning as-is`);
                        return tensor;
                      }
                      
                      console.log(`[GrammarCorrector] 📊 ${name} - dims:`, tensor.dims, 'type:', tensor.type, 'has cpuData:', !!tensor.cpuData, 'has data:', !!tensor.data);
                      
                      const dims = tensor.dims || [1, tensor.size || (tensor.cpuData?.length || tensor.data?.length || 0)];
                      const type = tensor.type || 'int64';
                      let arrayData = null;
                      
                      // Extract data from cpuData or data
                      if (tensor.cpuData) {
                        if (tensor.cpuData instanceof BigInt64Array || tensor.cpuData instanceof BigUint64Array) {
                          arrayData = Array.from(tensor.cpuData).map(x => Number(x));
                        } else {
                          arrayData = Array.from(tensor.cpuData);
                        }
                        console.log(`[GrammarCorrector] ✅ Extracted ${arrayData.length} elements from ${name}.cpuData`);
                      } else if (tensor.data) {
                        if (tensor.data instanceof BigInt64Array || tensor.data instanceof BigUint64Array) {
                          arrayData = Array.from(tensor.data).map(x => Number(x));
                        } else {
                          arrayData = Array.from(tensor.data);
                        }
                        console.log(`[GrammarCorrector] ✅ Extracted ${arrayData.length} elements from ${name}.data`);
                      } else {
                        console.warn(`[GrammarCorrector] ⚠️ ${name} has no cpuData or data, cannot fix`);
                        return tensor;
                      }
                      
                      if (!arrayData || arrayData.length === 0) {
                        console.warn(`[GrammarCorrector] ⚠️ ${name} has no data to extract, returning original`);
                        return tensor;
                      }
                      
                      // Ensure dims match data length
                      const totalElements = arrayData.length;
                      const dimsProduct = dims.reduce((a, b) => a * b, 1);
                      const finalDims = dimsProduct !== totalElements ? [1, totalElements] : dims;
                      
                      // Create BigInt64Array for int64
                      let typedArray;
                      if (type === 'int64') {
                        const bigIntData = arrayData.map(x => BigInt(x));
                        typedArray = new BigInt64Array(bigIntData);
                        console.log(`[GrammarCorrector] ✅ Created BigInt64Array for ${name}, length:`, typedArray.length);
                      } else {
                        typedArray = new (tensor.cpuData?.constructor || Int32Array)(arrayData);
                        console.log(`[GrammarCorrector] ✅ Created ${typedArray.constructor.name} for ${name}`);
                      }
                      
                      const fixedTensor = new Tensor(type, typedArray, finalDims);
                      // CRITICAL: location is a getter property, only set dataLocation
                      fixedTensor.dataLocation = tensor.dataLocation || 'cpu';
                      
                      // CRITICAL: Also ensure data property is explicitly set
                      fixedTensor.data = typedArray;
                      
                      // console.log(`[GrammarCorrector] ✅ Fixed ${name} - dims:`, fixedTensor.dims, 'has data:', !!fixedTensor.data, 'location:', fixedTensor.location);
                      return fixedTensor;
                    };
                    
                    // Fix input_ids
                    const fixedInputIds = fixTensor(inputIdsTensor, 'input_ids');
                    
                    // Fix attention_mask if it exists
                    let fixedAttentionMask = null;
                    if (inputs && inputs.attention_mask) {
                      fixedAttentionMask = fixTensor(inputs.attention_mask, 'attention_mask');
                        // Double-check it was fixed
                        if (fixedAttentionMask instanceof Tensor) {
                          if (!fixedAttentionMask.dataLocation) {
                            fixedAttentionMask.dataLocation = 'cpu';
                            // console.log('[GrammarCorrector] 🔧 Force-set attention_mask.dataLocation = "cpu"');
                          }
                        if (!fixedAttentionMask.data) {
                          // console.warn('[GrammarCorrector] ⚠️ attention_mask still has no data after fix!');
                        }
                      }
                    } else {
                      // console.warn('[GrammarCorrector] ⚠️ No attention_mask found in inputs');
                    }
                    
                    // CRITICAL: model.generate() may access inputs.attention_mask directly from the tokenizer
                    // We need to replace the original inputs object with our fixed tensors
                    // Create a new inputs object with fixed tensors
                    const fixedInputs = {
                      input_ids: fixedInputIds,
                    };
                    
                    // Always include attention_mask if we have it
                    if (fixedAttentionMask) {
                      fixedInputs.attention_mask = fixedAttentionMask;
                      console.log('[GrammarCorrector] ✅ Added fixed attention_mask to fixedInputs');
                    }
                    
                    // Replace the original inputs object to ensure model.generate() uses fixed tensors
                    // Delete old properties first, then assign new ones
                    if ('input_ids' in inputs) {
                      delete inputs.input_ids;
                    }
                    if ('attention_mask' in inputs) {
                      delete inputs.attention_mask;
                    }
                    
                    // Assign fixed tensors
                    inputs.input_ids = fixedInputIds;
                    if (fixedAttentionMask) {
                      inputs.attention_mask = fixedAttentionMask;
                      console.log('[GrammarCorrector] ✅ Replaced inputs.attention_mask with fixed version');
                    }
                    
                    console.log('[GrammarCorrector] ✅ Updated inputs object with fixed tensors');
                    console.log('[GrammarCorrector] 💡 Tensor type conversion (int64) will be handled by session patch')
                    
                    const generateOptions = {
                      max_new_tokens: options.max_new_tokens || 256,
                      do_sample: false,
                    };
                    
                    // Apply the Tensor._subarray patch before generation
                    await patchTensorSubarray();
                    
                    // CRITICAL: AGGRESSIVE monkey-patch - wrap ALL Xenova generation functions
                    // This intercepts array access at the source
                    if (!global._xenovaAggressivePatch) {
                      try {
                        // Patch 1: Wrap Array.prototype to auto-initialize on write
                        const originalDefineProperty = Object.defineProperty;
                        Object.defineProperty = function(obj, prop, descriptor) {
                          // Intercept array index sets
                          if (descriptor && descriptor.set && obj && typeof obj === 'object') {
                            const originalSet = descriptor.set;
                            descriptor.set = function(value) {
                              // Auto-initialize array if needed
                              if (Array.isArray(this) && typeof prop === 'string' && !isNaN(prop)) {
                                const index = parseInt(prop);
                                while (this.length <= index) {
                                  this.push(undefined);
                                }
                              }
                              return originalSet.call(this, value);
                            };
                          }
                          return originalDefineProperty.call(Object, obj, prop, descriptor);
                        };
                        
                        // Patch 2: Wrap Xenova's _call and closure functions with error handling
                        const safeWrapper = (fn, name) => {
                          return function(...args) {
                            try {
                              // Pre-process: ensure all array arguments are initialized
                              args = args.map(arg => {
                                if (arg === undefined && name.includes('_call')) {
                                  console.warn(`[GrammarCorrector] ⚠️ ${name} received undefined, converting to empty array`);
                                  return [];
                                }
                                return arg;
                              });
                              return fn.apply(this, args);
                            } catch (err) {
                              if (err.message.includes('Cannot set properties of undefined')) {
                                console.error(`[GrammarCorrector] ❌ Array access error in ${name}:`, err.message);
                                console.error('[GrammarCorrector] 💡 This model has deep compatibility issues with Node.js');
                                console.error('[GrammarCorrector] 💡 Recommendation: Set HF_TOKEN for API fallback or use ENABLE_XENOVA_GRAMMAR=false');
                                return undefined; // Return safely
                              }
                              throw err; // Re-throw other errors
                            }
                          };
                        };
                        
                        // Apply patches at import time
                        import('@xenova/transformers/src/utils/generation.js').then(genModule => {
                          if (genModule.default && genModule.default._call) {
                            const original = genModule.default._call;
                            genModule.default._call = safeWrapper(original, 'generation._call');
                            console.log('[GrammarCorrector] ✅ Wrapped generation._call with safe error handling');
                          }
                        }).catch(() => {});
                        
                        import('@xenova/transformers/src/utils/core.js').then(coreModule => {
                          if (coreModule.closure) {
                            const original = coreModule.closure;
                            coreModule.closure = safeWrapper(original, 'core.closure');
                            console.log('[GrammarCorrector] ✅ Wrapped core.closure with safe error handling');
                          }
                        }).catch(() => {});
                        
                        global._xenovaAggressivePatch = true;
                        console.log('[GrammarCorrector] ✅ Applied AGGRESSIVE Xenova compatibility patches');
                      } catch (patchError) {
                        console.error('[GrammarCorrector] ❌ Aggressive patch failed:', patchError.message);
                      }
                    }
                    
                    // CRITICAL: Patch Tensor.slice to handle undefined data
                    // (Tensor is already imported at the top of this function)
                    if (Tensor.prototype.slice && !Tensor.prototype._originalSlice) {
                      Tensor.prototype._originalSlice = Tensor.prototype.slice;
                      Tensor.prototype.slice = function(...args) {
                        // Guard against undefined data before calling slice
                        if (!this.data && this.cpuData) {
                          // console.warn('[GrammarCorrector] ⚠️ Tensor.slice called with undefined data, fixing from cpuData');
                          // Convert cpuData to appropriate typed array for data
                          if (this.cpuData instanceof BigInt64Array) {
                            this.data = this.cpuData;
                          } else if (this.cpuData instanceof Int32Array) {
                            this.data = this.cpuData;
                          } else if (this.cpuData instanceof Float32Array) {
                            this.data = this.cpuData;
                          } else {
                            this.data = this.cpuData;
                          }
                        }
                        
                        // If still no data, return empty tensor of same type
                        if (!this.data) {
                          // console.error('[GrammarCorrector] ❌ Tensor.slice called with no data/cpuData, returning empty tensor');
                          const EmptyArray = this.type?.includes('float') ? Float32Array : 
                                           this.type?.includes('int64') ? BigInt64Array : Int32Array;
                          return new Tensor(this.type, new EmptyArray(0), [0]);
                        }
                        
                        return this._originalSlice.apply(this, args);
                      };
                      console.log('[GrammarCorrector] ✅ Patched Tensor.prototype.slice for undefined data safety');
                    }
                    
                    // CRITICAL: Patch Tensor array access to prevent "Cannot set properties of undefined"
                    // Xenova's generation code tries to set array indices that may not exist
                    if (Tensor.prototype._originalDataGetter === undefined) {
                      // Create a safer Proxy wrapper for Tensor.data access
                      const originalDataDescriptor = Object.getOwnPropertyDescriptor(Tensor.prototype, 'data');
                      
                      Object.defineProperty(Tensor.prototype, '_safeData', {
                        get: function() {
                          const data = this._internalData || (originalDataDescriptor?.get ? originalDataDescriptor.get.call(this) : undefined);
                          if (!data) return data;
                          
                          // Wrap data in a Proxy that auto-initializes on set
                          return new Proxy(data, {
                            set: function(target, prop, value) {
                              // Ensure the index exists before setting
                              if (typeof prop === 'string' && !isNaN(prop)) {
                                const index = parseInt(prop);
                                // Auto-expand array if needed
                                if (target && index >= 0) {
                                  target[index] = value;
                                  return true;
                                }
                              }
                              target[prop] = value;
                              return true;
                            }
                          });
                        },
                        set: function(value) {
                          this._internalData = value;
                          if (originalDataDescriptor?.set) {
                            originalDataDescriptor.set.call(this, value);
                          }
                        }
                      });
                      
                      Tensor.prototype._originalDataGetter = true;
                      console.log('[GrammarCorrector] ✅ Patched Tensor data access for safe array index assignment');
                    }
                    
                    // Debug: Check model structure
                    console.log('[GrammarCorrector] 🔍 Debugging model structure:');
                    console.log('[GrammarCorrector] - model type:', typeof model);
                    console.log('[GrammarCorrector] - has session?', !!model?.session);
                    console.log('[GrammarCorrector] - has decoder_merged_session?', !!model?.decoder_merged_session);
                    
                    // Verify model is loaded
                    if (!model) {
                      throw new Error('Model is not initialized - model object is undefined');
                    }
                    
                    // Helper function to patch a session's run method
                    const patchSessionRun = (session, sessionName) => {
                      if (!session || !session.handler || !session.handler.run) {
                        console.warn(`[GrammarCorrector] ⚠️ ${sessionName} does not have handler.run - skipping patch`);
                        return;
                      }
                      
                      const originalRun = session.handler.run.bind(session.handler);
                      session.handler.run = async function(feeds, fetches, options) {
                        // console.log(`[GrammarCorrector] 🔧 Patching ${sessionName} inputs before ONNX Runtime...`);
                        for (const key in feeds) {
                          const tensor = feeds[key];
                          if (tensor && typeof tensor === 'object') {
                            // Fix missing .data property AND ensure correct type
                            if (!tensor.data && tensor.cpuData) {
                              // If cpuData is already BigInt64Array, use it directly
                              if (tensor.cpuData instanceof BigInt64Array) {
                                tensor.data = tensor.cpuData;
                                tensor.type = 'int64';
                                // console.log(`[GrammarCorrector] ✅ Fixed ${sessionName} ${key}: set BigInt64Array data (int64, ${tensor.data.length})`);
                              }
                              // If cpuData is Int32Array, convert to BigInt64Array for int64 models
                              else if (tensor.cpuData instanceof Int32Array && (tensor.type === 'int64' || key.includes('mask') || key.includes('ids'))) {
                                tensor.data = new BigInt64Array(Array.from(tensor.cpuData, x => BigInt(x)));
                                tensor.type = 'int64';
                                // console.log(`[GrammarCorrector] ✅ Fixed ${sessionName} ${key}: Int32Array → BigInt64Array (int64, ${tensor.data.length})`);
                              }
                              // For float tensors, use directly
                              else if (tensor.cpuData instanceof Float32Array) {
                                tensor.data = tensor.cpuData;
                                // console.log(`[GrammarCorrector] ✅ Fixed ${sessionName} ${key}: set Float32Array data`);
                              }
                              // Fallback: use cpuData as-is
                              else {
                                tensor.data = tensor.cpuData;
                                // console.log(`[GrammarCorrector] ✅ Fixed ${sessionName} ${key}: set data from cpuData (type: ${tensor.cpuData?.constructor?.name})`);
                              }
                            }
                            
                            // CRITICAL: Make .data immutable so it doesn't get lost during tensor operations
                            // Xenova's tensor.slice() expects .data to always be present
                            if (tensor.data && !Object.getOwnPropertyDescriptor(tensor, 'data')?.get) {
                              const dataValue = tensor.data;
                              Object.defineProperty(tensor, 'data', {
                                get: function() { return dataValue; },
                                set: function(v) { /* ignore - keep our fixed value */ },
                                enumerable: true,
                                configurable: false
                              });
                            }
                          }
                        }
                        // Pass all arguments to original run (feeds, fetches, options)
                        return originalRun(feeds, fetches, options);
                      };
                      console.log(`[GrammarCorrector] ✅ Patched ${sessionName}.handler.run`);
                    };
                    
                    // Patch the actual sessions that exist (session and decoder_merged_session, not sessions)
                    if (model.session) {
                      patchSessionRun(model.session, 'encoder session');
                    } else {
                      console.warn('[GrammarCorrector] ⚠️ No model.session found');
                    }
                    
                    if (model.decoder_merged_session) {
                      patchSessionRun(model.decoder_merged_session, 'decoder_merged_session');
                    } else {
                      console.warn('[GrammarCorrector] ⚠️ No model.decoder_merged_session found');
                    }
                    
                    // CRITICAL: Pass both input_ids AND attention_mask
                    // model.generate accepts inputs_attention_mask as 4th argument options
                    console.log('[GrammarCorrector] 🧠 Running ONNX model inference...');
                    const outputs = await model.generate(
                      fixedInputIds,
                      generateOptions,
                      null, // logits_processor
                      { inputs_attention_mask: fixedAttentionMask } // options
                    );
                    console.log('[GrammarCorrector] ✅ model.generate() completed successfully');
                    
                    // Handle different output formats from model.generate
                    // model.generate typically returns the token IDs directly or wrapped in an object
                    let outputIds = null;
                    
                    try {
                      // Try to extract token IDs from various possible formats
                      if (Array.isArray(outputs)) {
                        // If it's an array, take the first element (sequence)
                        outputIds = outputs[0];
                        // If first element is also an array or has data, extract further
                        if (outputIds && typeof outputIds === 'object' && outputIds.data) {
                          outputIds = outputIds.data;
                        }
                      } else if (outputs && typeof outputs === 'object') {
                        // Check for common property names
                        if (outputs.sequences !== undefined && outputs.sequences !== null) {
                          const seq = Array.isArray(outputs.sequences) ? outputs.sequences[0] : outputs.sequences;
                          if (seq && seq.data !== undefined) {
                            outputIds = seq.data;
                          } else if (seq) {
                            outputIds = seq;
                          }
                        } else if (outputs.input_ids !== undefined && outputs.input_ids !== null) {
                          const ids = outputs.input_ids;
                          if (ids.data !== undefined) {
                            outputIds = ids.data;
                          } else {
                            outputIds = ids;
                          }
                        } else if (outputs[0] !== undefined) {
                          outputIds = outputs[0];
                        } else if (outputs.data !== undefined) {
                          outputIds = outputs.data;
                        } else {
                          // Use the object itself - might be a Tensor
                          outputIds = outputs;
                        }
                      } else {
                        outputIds = outputs;
                      }
                      
                      // Convert to plain array if needed to avoid 'subarray' errors
                      if (outputIds && typeof outputIds === 'object' && outputIds !== null) {
                        // If it's a TypedArray or similar, convert to regular array
                        if (!Array.isArray(outputIds)) {
                          // Check if it has length property (TypedArray-like)
                          if ('length' in outputIds && typeof outputIds.length === 'number') {
                            try {
                              // Convert TypedArray to regular array
                              outputIds = Array.from(outputIds);
                            } catch (convertError) {
                              // If conversion fails, try using subarray (but safely)
                              if ('subarray' in outputIds && typeof outputIds.subarray === 'function') {
                                outputIds = outputIds.subarray(0);
                              }
                            }
                          }
                        }
                      }
                      
                      if (!outputIds || (Array.isArray(outputIds) && outputIds.length === 0)) {
                        throw new Error('Could not extract valid token IDs from model.generate output');
                      }
                      
                      // tokenizer.decode expects an array or tensor-like object
                      // Pass it directly - tokenizer should handle the conversion
                      const decoded = await tokenizer.decode(outputIds, { skip_special_tokens: true });
                  return [{ generated_text: decoded }];
                    } catch (decodeError) {
                      // If decode fails, log the error and the output format for debugging
                      console.error('[GrammarCorrector] Decode error:', decodeError.message);
                      console.error('[GrammarCorrector] Output type:', typeof outputs);
                      console.error('[GrammarCorrector] Output isArray:', Array.isArray(outputs));
                      if (outputs && typeof outputs === 'object') {
                        console.error('[GrammarCorrector] Output keys:', Object.keys(outputs));
                      }
                      throw decodeError;
                    }
                  } catch (error) {
                    console.error('[GrammarCorrector] Pipeline wrapper error:', error.message);
                    console.error('[GrammarCorrector] Error stack:', error.stack);
                    throw error;
                  }
                };
                
                console.log(`[GrammarCorrector] ✅ Direct model loaded: ${directModelName}`);
                this.status = 'ready';
                this.useAPI = false;
            }
          } catch (firstError) {
            // If model loading fails, try with fallback approach
            console.warn(`[GrammarCorrector] ⚠️ Model loading failed: ${firstError.message}`);
            if (modelToTry === this.modelName) {
              console.log(`[GrammarCorrector] 🔄 Trying direct loading approach...`);
              
              // Retry with original model
              try {
                this.pipeline = await pipeline(
                  'text2text-generation',
                  modelToTry,
                  {
                    quantized: false,
                  }
                );
                console.log(`[GrammarCorrector] ✅ Original model loaded via pipeline: ${modelToTry}`);
                this.status = 'ready';
                this.useAPI = false;
              } catch (pipelineError2) {
                  // Last resort: try direct loading
                console.log(`[GrammarCorrector] 🔄 Pipeline failed, trying direct loading...`);
                  const fallbackModelName = this.modelName;
                  console.log(`[GrammarCorrector] Using ${fallbackModelName} for fallback direct loading`);
                  const tokenizer = await Promise.race([
                    AutoTokenizer.from_pretrained(fallbackModelName),
                    new Promise((_, reject) => 
                      setTimeout(() => reject(new Error('Tokenizer load timeout after 60s')), 60000)
                    )
                  ]);
                  const model = await Promise.race([
                    AutoModelForSeq2SeqLM.from_pretrained(fallbackModelName, {
                      quantized: true, // Use quantized for faster loading
                    }),
                    new Promise((_, reject) => 
                      setTimeout(() => reject(new Error('Model load timeout after 120s')), 120000)
                    )
                  ]);
                
                this.pipeline = async (text, options = {}) => {
                    try {
                      // Tokenize with proper options for @xenova/transformers
                      // Note: @xenova/transformers uses different options than Python transformers
                  const inputs = await tokenizer(text);
                      
                      // Validate inputs structure
                      if (!inputs) {
                        throw new Error('Tokenizer returned undefined');
                      }
                      
                      // Handle different tokenizer output formats from @xenova/transformers
                      let inputIds;
                      if (inputs && inputs.input_ids) {
                        const inputIdsValue = inputs.input_ids;
                        // Check if it's a Tensor object with data property
                        if (inputIdsValue.data !== undefined) {
                          inputIds = inputIdsValue.data;
                        } else if (inputIdsValue && typeof inputIdsValue === 'object' && inputIdsValue !== null && 'subarray' in inputIdsValue) {
                          // TypedArray with subarray method
                          inputIds = inputIdsValue;
                        } else if (Array.isArray(inputIdsValue)) {
                          inputIds = inputIdsValue;
                        } else {
                          inputIds = inputIdsValue;
                        }
                      } else if (Array.isArray(inputs)) {
                        inputIds = inputs[0] || inputs;
                      } else if (inputs && inputs.data) {
                        inputIds = inputs.data;
                      } else {
                        inputIds = inputs;
                      }
                      
                      if (!inputIds) {
                        throw new Error('Could not extract input_ids from tokenizer output');
                      }
                      
                      // Generate with model
                      // Use minimal options to avoid seq2seqStartBeams bug
                      // The bug occurs when the library tries to initialize beam search with undefined tensor data
                      const generateOptions = {
                    max_new_tokens: options.max_new_tokens || 256,
                        num_beams: 1, // Force single beam to avoid beam search code path
                        do_sample: false, // Force greedy decoding
                        // Don't pass early_stopping or temperature as they might trigger the buggy code path
                      };
                      
                      const outputs = await model.generate(inputIds, generateOptions);
                      
                      // Handle different output formats from model.generate
                      // model.generate typically returns the token IDs directly or wrapped in an object
                      let outputIds = null;
                      
                      try {
                        // Try to extract token IDs from various possible formats
                        if (Array.isArray(outputs)) {
                          // If it's an array, take the first element (sequence)
                          outputIds = outputs[0];
                          // If first element is also an array or has data, extract further
                          if (outputIds && typeof outputIds === 'object' && outputIds.data) {
                            outputIds = outputIds.data;
                          }
                        } else if (outputs && typeof outputs === 'object') {
                          // Check for common property names
                          if (outputs.sequences !== undefined && outputs.sequences !== null) {
                            const seq = Array.isArray(outputs.sequences) ? outputs.sequences[0] : outputs.sequences;
                            if (seq && seq.data !== undefined) {
                              outputIds = seq.data;
                            } else if (seq) {
                              outputIds = seq;
                            }
                          } else if (outputs.input_ids !== undefined && outputs.input_ids !== null) {
                            const ids = outputs.input_ids;
                            if (ids.data !== undefined) {
                              outputIds = ids.data;
                            } else {
                              outputIds = ids;
                            }
                          } else if (outputs[0] !== undefined) {
                            outputIds = outputs[0];
                          } else if (outputs.data !== undefined) {
                            outputIds = outputs.data;
                          } else {
                            // Use the object itself - might be a Tensor
                            outputIds = outputs;
                          }
                        } else {
                          outputIds = outputs;
                        }
                        
                        // Convert to plain array if needed to avoid 'subarray' errors
                        if (outputIds && typeof outputIds === 'object' && outputIds !== null) {
                          // If it's a TypedArray or similar, convert to regular array
                          if (!Array.isArray(outputIds)) {
                            // Check if it has length property (TypedArray-like)
                            if ('length' in outputIds && typeof outputIds.length === 'number') {
                              try {
                                // Convert TypedArray to regular array
                                outputIds = Array.from(outputIds);
                              } catch (convertError) {
                                // If conversion fails, try using subarray (but safely)
                                if ('subarray' in outputIds && typeof outputIds.subarray === 'function') {
                                  outputIds = outputIds.subarray(0);
                                }
                              }
                            }
                          }
                        }
                        
                        if (!outputIds || (Array.isArray(outputIds) && outputIds.length === 0)) {
                          throw new Error('Could not extract valid token IDs from model.generate output');
                        }
                        
                        // tokenizer.decode expects an array or tensor-like object
                        // Pass it directly - tokenizer should handle the conversion
                        const decoded = await tokenizer.decode(outputIds, { skip_special_tokens: true });
                  return [{ generated_text: decoded }];
                      } catch (decodeError) {
                        // If decode fails, log the error and the output format for debugging
                        console.error('[GrammarCorrector] Decode error:', decodeError.message);
                        console.error('[GrammarCorrector] Output type:', typeof outputs);
                        console.error('[GrammarCorrector] Output isArray:', Array.isArray(outputs));
                        if (outputs && typeof outputs === 'object') {
                          console.error('[GrammarCorrector] Output keys:', Object.keys(outputs));
                        }
                        throw decodeError;
                      }
                    } catch (error) {
                      console.error('[GrammarCorrector] Pipeline wrapper error:', error.message);
                      console.error('[GrammarCorrector] Error stack:', error.stack);
                      throw error;
                    }
                };
                
                console.log(`[GrammarCorrector] ✅ Original model loaded directly: ${modelToTry}`);
                this.status = 'ready';
                this.useAPI = false;
              }
            } else {
              throw firstError;
            }
          }
        } catch (localError) {
          console.warn(`[GrammarCorrector] ⚠️ Local model failed: ${localError.message}`);
          console.log('[GrammarCorrector] 🔄 Falling back to HuggingFace Inference API...');
          this.status = 'loading';
          console.log('[GrammarCorrector] 📋 Status: LOADING - Testing API connection...');
          
          // Test API connection
          try {
            const testResponse = await fetch(this.apiUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(this.hfToken && { 'Authorization': `Bearer ${this.hfToken}` })
              },
              body: JSON.stringify({ inputs: 'test' }),
              signal: AbortSignal.timeout(10000)
            });
            
            if (testResponse.ok || testResponse.status === 503) {
              console.log(`[GrammarCorrector] ✅ Using HuggingFace Inference API for ${this.originalModelName}`);
              console.log('[GrammarCorrector] 📋 Status: READY - Using API mode');
              this.useAPI = true;
              this.pipeline = true; // Mark as initialized
              this.status = 'ready';
              const elapsed = Date.now() - this.initStartTime;
              console.log(`[GrammarCorrector] ⏱️ API fallback ready in ${(elapsed / 1000).toFixed(1)}s`);
            } else {
              throw new Error(`API test failed: ${testResponse.statusText}`);
            }
          } catch (apiError) {
            console.error('[GrammarCorrector] ❌ API fallback also failed:', apiError.message);
            this.status = 'failed';
            this.enabled = false;
            throw new Error(`Both local model and API failed. Local: ${localError.message}, API: ${apiError.message}`);
          }
        }
        
        this.initializing = false;
        clearInterval(statusInterval); // Stop status updates
        if (this.status !== 'failed') {
          const totalElapsed = Date.now() - this.initStartTime;
          console.log('[GrammarCorrector] ✅ Status: READY - Grammar correction active');
          console.log(`[GrammarCorrector] ⏱️ Total initialization time: ${(totalElapsed / 1000).toFixed(1)}s`);
        }
      } catch (error) {
        clearInterval(statusInterval); // Stop status updates on error
        console.error('[GrammarCorrector] ❌ Failed to initialize:', error);
        this.status = 'failed';
        this.enabled = false;
        this.initializing = false;
        throw error;
      }
    })();

    return this.initPromise;
  }

  /**
   * Calculate Jaro-Winkler similarity between two strings
   * Returns a value between 0 (completely different) and 1 (identical)
   * Used to detect semantic drift in corrections
   * @param {string} s1 - First string
   * @param {string} s2 - Second string
   * @returns {number} Similarity score (0-1)
   */
  jaroWinklerSimilarity(s1, s2) {
    // Normalize strings
    const str1 = s1.toLowerCase().trim();
    const str2 = s2.toLowerCase().trim();

    if (str1 === str2) return 1.0;
    if (str1.length === 0 || str2.length === 0) return 0.0;

    // Jaro similarity calculation
    const matchWindow = Math.floor(Math.max(str1.length, str2.length) / 2) - 1;
    const str1Matches = new Array(str1.length).fill(false);
    const str2Matches = new Array(str2.length).fill(false);

    let matches = 0;
    let transpositions = 0;

    // Identify matches
    for (let i = 0; i < str1.length; i++) {
      const start = Math.max(0, i - matchWindow);
      const end = Math.min(i + matchWindow + 1, str2.length);

      for (let j = start; j < end; j++) {
        if (str2Matches[j] || str1[i] !== str2[j]) continue;
        str1Matches[i] = str2Matches[j] = true;
        matches++;
        break;
      }
    }

    if (matches === 0) return 0.0;

    // Count transpositions
    let k = 0;
    for (let i = 0; i < str1.length; i++) {
      if (!str1Matches[i]) continue;
      while (!str2Matches[k]) k++;
      if (str1[i] !== str2[k]) transpositions++;
      k++;
    }

    // Jaro similarity
    const jaro = (
      matches / str1.length +
      matches / str2.length +
      (matches - transpositions / 2) / matches
    ) / 3;

    // Winkler modification (boost for common prefix)
    let prefix = 0;
    for (let i = 0; i < Math.min(str1.length, str2.length, 4); i++) {
      if (str1[i] === str2[i]) prefix++;
      else break;
    }

    return jaro + prefix * 0.1 * (1 - jaro);
  }

  /**
   * Check if correction has drifted too far semantically from original
   * Uses BOTH Jaro-Winkler similarity AND word-level semantic checks
   * @param {string} original - Original text
   * @param {string} corrected - Corrected text
   * @returns {boolean} True if texts are semantically similar enough
   */
  isSemanticallyValid(original, corrected) {
    // First check: Jaro-Winkler character-level similarity
    const charSimilarity = this.jaroWinklerSimilarity(original, corrected);

    // Count word changes EARLY to adjust thresholds
    const origWords = original.toLowerCase().split(/\s+/).filter(w => w.length > 2); // Only check meaningful words (>2 chars)
    const corrWords = corrected.toLowerCase().split(/\s+/).filter(w => w.length > 2);

    // Pre-scan: Count how many words actually changed
    let quickChangeCount = 0;
    for (let i = 0; i < Math.min(origWords.length, corrWords.length); i++) {
      const origWord = origWords[i].replace(/[.,!?;:'"]/g, '');
      const corrWord = corrWords[i].replace(/[.,!?;:'"]/g, '');
      if (origWord !== corrWord) quickChangeCount++;
    }

    // SPECIAL HANDLING: If only 1 word changed, be MUCH more lenient
    // This allows legitimate single-word corrections like "there" → "their"
    const isSingleWordChange = quickChangeCount === 1;

    // Adjust character similarity threshold based on number of changes
    let MIN_CHAR_SIMILARITY = 0.85; // Default: 85% character similarity
    if (isSingleWordChange) {
      MIN_CHAR_SIMILARITY = 0.70; // More lenient: 70% for single-word changes
      console.log(`[GrammarCorrector] 🔍 Single word change detected - using relaxed threshold (70%)`);
    }

    if (charSimilarity < MIN_CHAR_SIMILARITY) {
      console.warn(`[GrammarCorrector] Character-level drift detected - similarity: ${(charSimilarity * 100).toFixed(1)}% (min: ${MIN_CHAR_SIMILARITY * 100}%)`);
      console.warn(`[GrammarCorrector]   Original: "${original.substring(0, 100)}"`);
      console.warn(`[GrammarCorrector]   Corrected: "${corrected.substring(0, 100)}"`);
      return false;
    }

    // Second check: Word-level semantic validation
    // This catches cases like "hear" → "tell" that have high character similarity

    // Check if any core words were completely changed (substituted with semantically different words)
    const meaningfulWordChanges = [];

    for (let i = 0; i < Math.min(origWords.length, corrWords.length); i++) {
      const origWord = origWords[i].replace(/[.,!?;:'"]/g, '');
      const corrWord = corrWords[i].replace(/[.,!?;:'"]/g, '');

      // Skip if words are the same or very similar (edit distance <= 2)
      if (origWord === corrWord) continue;
      if (Math.abs(origWord.length - corrWord.length) <= 1 && this.editDistance(origWord, corrWord) <= 2) continue;

      // Check if this is a known acceptable transformation (capitalization, punctuation)
      if (origWord.toLowerCase() === corrWord.toLowerCase()) continue;

      // IMPORTANT: Check if this is a function word (grammatical word) change
      // Function words like is/are/am/was/were/have/has/do/does are short and have low similarity
      // but are legitimate grammar corrections
      if (this.isFunctionWordPair(origWord, corrWord)) {
        continue; // Allow function word changes (these are grammar corrections, not semantic)
      }

      // This is a meaningful word change - check if it's semantic drift
      meaningfulWordChanges.push({ orig: origWord, corr: corrWord, position: i });
    }

    // If there are meaningful word substitutions, check if they're semantic changes
    if (meaningfulWordChanges.length > 0) {
      // SPECIAL CASE: If only 1 word changed AND it's the only meaningful change, be very lenient
      // Allow the model to make single corrections when context strongly suggests it
      const onlyOneWordChanged = meaningfulWordChanges.length === 1 && isSingleWordChange;

      // Use PURELY ALGORITHMIC approach - no hardcoded word lists
      const problematicChanges = meaningfulWordChanges.filter(change => {
        const wordSimilarity = this.jaroWinklerSimilarity(change.orig, change.corr);
        const editDist = this.editDistance(change.orig, change.corr);
        const sharedPrefix = this.longestCommonPrefix(change.orig, change.corr);
        const sharedSuffix = this.longestCommonSuffix(change.orig, change.corr);

        // ALGORITHM: Determine if this is a grammar correction or semantic change

        // Category 1: Very similar words (likely typos, punctuation, capitalization)
        // Example: "hello" → "Hello", "dont" → "don't"
        if (wordSimilarity > 0.85) {
          return false; // Allow - very similar, likely grammatical
        }

        // Category 2: Shared root with suffix changes (likely verb tense, plurals)
        // Example: "going" → "went" (different but same verb), "car" → "cars"
        // Check: 3+ char prefix OR 3+ char suffix match
        if (sharedPrefix >= 3 || sharedSuffix >= 3) {
          return false; // Allow - shared root indicates related words
        }

        // Category 3: Small edit distance with reasonable similarity (likely homophones or related forms)
        // Example: "there" → "their", "hear" → "here" (homophones)
        // UPDATED: More lenient for single-word changes, stricter for clearly unrelated words
        const maxWordLen = Math.max(change.orig.length, change.corr.length);
        const editRatio = editDist / maxWordLen;

        // Allow small edit distances more freely - these are often typo fixes or homophones
        if (editDist <= 2) {
          return false; // Allow - very small change, likely typo/homophone
        }

        // For edit distance 3, check similarity and ratio
        if (editDist === 3) {
          // More lenient similarity check for edit distance 3
          const similarityThreshold = onlyOneWordChanged ? 0.40 : 0.55; // 40% vs 55%
          if (wordSimilarity > similarityThreshold && editRatio < 0.6) {
            return false; // Allow - decent similarity with small edit distance
          }
        }

        // For edit distance 4+, require higher similarity
        if (editDist >= 4 && wordSimilarity > 0.65 && editRatio < 0.7) {
          return false; // Allow only if very similar
        }

        // Category 4: Same length with high character overlap (transpositions, homophones)
        // Example: "form" → "from", "quiet" → "quite"
        // UPDATED: Require EITHER high similarity OR shared structure (prefix/suffix)
        const lengthSimilar = Math.abs(change.orig.length - change.corr.length) <= 1;
        if (lengthSimilar) {
          // For same-length words, require BOTH decent similarity AND some structure
          // OR very high similarity (>70%) without structure
          const hasStructure = sharedPrefix >= 2 || sharedSuffix >= 2;
          const highSimilarity = wordSimilarity > 0.70; // 70%+ can pass without structure
          const mediumSimilarityWithStructure = wordSimilarity > 0.50 && hasStructure;

          if (highSimilarity || mediumSimilarityWithStructure) {
            return false; // Allow - same length with good overlap AND structure
          }
        }

        // Category 5: REJECT - Low similarity AND no shared structure (semantic change)
        // Example: "hear" → "tell" (50% sim, no prefix/suffix)
        //          "has" → "yet" (0% sim)
        // Reject if: similarity < threshold AND no shared prefix/suffix
        // UPDATED: Even for single-word changes, require EITHER high similarity OR structural similarity
        let minSimilarityThreshold;
        let requiresStructure = false;

        if (onlyOneWordChanged) {
          // For single-word changes: require 60% similarity if NO structural match
          // OR accept lower similarity (35%) if there IS structural match (prefix/suffix >= 2)
          if (sharedPrefix < 2 && sharedSuffix < 2) {
            // No structural similarity - require higher word similarity
            minSimilarityThreshold = 0.60; // Need 60% if no shared structure
            requiresStructure = true;
          } else {
            // Has structural similarity - allow lower threshold
            minSimilarityThreshold = 0.35; // Can be 35% if has shared root
          }
        } else {
          // For multi-word changes, be stricter
          minSimilarityThreshold = change.orig.length <= 3 || change.corr.length <= 3 ? 0.4 : 0.5; // 40%/50%
        }

        // CRITICAL: For single-word changes with NO structure, require high similarity
        // This catches "hear" → "tell" (50% sim, no structure) while allowing "there" → "their" (50% sim, shared structure)
        if (wordSimilarity < minSimilarityThreshold && (sharedPrefix < 3 && sharedSuffix < 2)) {
          return true; // Reject - likely semantic substitution
        }

        // Category 6: Medium similarity but no structural relationship (borderline cases)
        // UPDATED: More lenient for single-word changes
        if (onlyOneWordChanged) {
          // For single-word changes: accept if similarity >= 35% OR has any shared structure
          if (wordSimilarity >= 0.35 || sharedPrefix >= 2 || sharedSuffix >= 2) {
            return false; // Allow - enough similarity for single change
          }
        } else {
          // For multi-word changes: be conservative - if 50-70% similar but no shared root, might be semantic
          if (wordSimilarity >= 0.5 && wordSimilarity < 0.7 && sharedPrefix < 2 && sharedSuffix < 2) {
            return true; // Reject - possible semantic change
          }
        }

        // Default: Allow (benefit of the doubt for grammatical corrections)
        return false;
      });

      if (problematicChanges.length > 0) {
        console.warn(`[GrammarCorrector] Semantic word substitutions detected (algorithmic check):`);
        problematicChanges.forEach(change => {
          const wordSim = this.jaroWinklerSimilarity(change.orig, change.corr);
          const edit = this.editDistance(change.orig, change.corr);
          const prefix = this.longestCommonPrefix(change.orig, change.corr);
          const suffix = this.longestCommonSuffix(change.orig, change.corr);
          console.warn(`[GrammarCorrector]   Pos ${change.position}: "${change.orig}" → "${change.corr}"`);
          console.warn(`[GrammarCorrector]     Similarity: ${(wordSim * 100).toFixed(1)}%, Edit: ${edit}, Prefix: ${prefix}, Suffix: ${suffix}`);
        });
        console.warn(`[GrammarCorrector]   Original: "${original}"`);
        console.warn(`[GrammarCorrector]   Corrected: "${corrected}"`);
        return false;
      }

      // Log accepted single-word changes for visibility
      if (onlyOneWordChanged && meaningfulWordChanges.length > 0) {
        const change = meaningfulWordChanges[0];
        const wordSim = this.jaroWinklerSimilarity(change.orig, change.corr);
        const edit = this.editDistance(change.orig, change.corr);
        console.log(`[GrammarCorrector] ✅ Accepted single-word change: "${change.orig}" → "${change.corr}" (sim: ${(wordSim * 100).toFixed(1)}%, edit: ${edit})`);
      }
    }

    return true;
  }

  /**
   * Calculate longest common prefix length between two words
   * @param {string} a - First word
   * @param {string} b - Second word
   * @returns {number} Length of shared prefix
   */
  longestCommonPrefix(a, b) {
    let i = 0;
    while (i < Math.min(a.length, b.length) && a[i].toLowerCase() === b[i].toLowerCase()) {
      i++;
    }
    return i;
  }

  /**
   * Calculate longest common suffix length between two words
   * @param {string} a - First word
   * @param {string} b - Second word
   * @returns {number} Length of shared suffix
   */
  longestCommonSuffix(a, b) {
    let i = 0;
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();
    while (i < Math.min(a.length, b.length) &&
           aLower[a.length - 1 - i] === bLower[b.length - 1 - i]) {
      i++;
    }
    return i;
  }

  /**
   * Check if two words are function words (grammatical words) that can legitimately change
   * Function words: is/are/am/was/were, have/has/had, do/does/did, etc.
   * These are SHORT grammatical words that have low similarity but are legitimate corrections
   * Uses ALGORITHMIC approach: check if both are short (≤4 chars) and both are common function words
   * @param {string} word1 - First word
   * @param {string} word2 - Second word
   * @returns {boolean} True if this is a legitimate function word pair
   */
  isFunctionWordPair(word1, word2) {
    const w1 = word1.toLowerCase();
    const w2 = word2.toLowerCase();

    // Must both be short (≤4 characters) - function words are always short
    if (w1.length > 4 || w2.length > 4) {
      return false;
    }

    // Common function word patterns (grammatical, not semantic)
    // Organized by grammatical category to catch semantic drift between categories
    const verbForms = ['is', 'are', 'am', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'having', 'do', 'does', 'did', 'done', 'doing'];
    const modals = ['can', 'cant', 'could', 'will', 'wont', 'would', 'shall', 'may', 'might', 'must', 'ought'];
    const articles = ['a', 'an', 'the'];
    const demonstratives = ['this', 'that', 'these', 'those'];
    const possessives = ['my', 'your', 'his', 'her', 'its', 'our', 'their'];
    const pronouns = ['i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'them', 'us'];
    const whWords = ['who', 'what', 'when', 'where', 'why', 'how'];
    const conjunctions = ['and', 'or', 'but', 'nor', 'yet', 'so', 'for'];
    const prepositions = ['in', 'on', 'at', 'to', 'by', 'with', 'from', 'of'];
    const negations = ['not', 'no', 'yes'];

    const allFunctionWords = [...verbForms, ...modals, ...articles, ...demonstratives, ...possessives, ...pronouns, ...whWords, ...conjunctions, ...prepositions, ...negations];

    // Check if BOTH words are in the function word list
    const w1IsFunction = allFunctionWords.includes(w1);
    const w2IsFunction = allFunctionWords.includes(w2);

    if (!w1IsFunction || !w2IsFunction) {
      return false; // At least one is not a function word
    }

    // IMPORTANT: Both are function words, but check if they're in the SAME grammatical category
    // Changing between categories is often semantic drift (e.g., "has" verb → "yet" conjunction)
    const categories = [verbForms, modals, articles, demonstratives, possessives, pronouns, whWords, conjunctions, prepositions, negations];

    for (const category of categories) {
      const w1InCategory = category.includes(w1);
      const w2InCategory = category.includes(w2);

      // If both are in the same category, it's a legitimate grammar correction
      if (w1InCategory && w2InCategory) {
        return true;
      }
    }

    // Both are function words but in DIFFERENT categories - likely semantic change
    return false;
  }

  /**
   * Calculate Levenshtein edit distance between two strings
   * Used to detect if words are similar (typos) vs completely different (semantic changes)
   * @param {string} a - First string
   * @param {string} b - Second string
   * @returns {number} Edit distance
   */
  editDistance(a, b) {
    const matrix = [];

    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1,     // insertion
            matrix[i - 1][j] + 1      // deletion
          );
        }
      }
    }

    return matrix[b.length][a.length];
  }

  /**
   * Validate that corrections are minimal - reject if model changed too much
   * This prevents the model from rewriting/paraphrasing entire sentences
   * Uses smarter heuristics that consider absolute word counts and semantic changes
   * @param {string} original - Original text
   * @param {string} corrected - Model-corrected text
   * @returns {string} Validated text (returns original if changes are too extensive)
   */
  applyMinimalCorrection(original, corrected) {
    // If texts are identical, accept immediately
    if (original === corrected) {
      return corrected;
    }

    // LAYER 1: Semantic similarity check (Jaro-Winkler)
    // This catches cases where words were completely changed (hear → tell)
    if (!this.isSemanticallyValid(original, corrected)) {
      console.warn('[GrammarCorrector] Rejected due to semantic drift');
      return original;
    }

    const origWords = original.split(/\s+/).filter(w => w.length > 0);
    const corrWords = corrected.split(/\s+/).filter(w => w.length > 0);

    // UPDATED: Smarter length validation
    // For very short inputs (<5 words), allow more flexibility (up to 50% change)
    // For longer inputs, be more strict
    const absoluteDiff = Math.abs(corrWords.length - origWords.length);
    const lengthChangeRatio = absoluteDiff / origWords.length;

    let maxLengthChange = 0.3; // Default 30% for normal text
    if (origWords.length <= 3) {
      maxLengthChange = 0.8; // 80% for very short inputs (1-3 words)
    } else if (origWords.length <= 5) {
      maxLengthChange = 0.6; // 60% for short inputs (4-5 words)
    } else if (origWords.length <= 10) {
      maxLengthChange = 0.4; // 40% for medium inputs (6-10 words)
    }

    // Only reject if BOTH percentage is high AND absolute difference is large
    if (lengthChangeRatio > maxLengthChange && absoluteDiff > 5) {
      console.warn(`[GrammarCorrector] Rejected - word count changed by ${(lengthChangeRatio * 100).toFixed(1)}% (${origWords.length} → ${corrWords.length}, +${absoluteDiff} words)`);
      return original;
    }

    // UPDATED: Smarter word-level difference check
    // Use Levenshtein-style comparison: count substitutions, not just position changes
    let substitutions = 0;
    let additions = 0;
    let deletions = 0;

    // Simple alignment: compare word by word, counting differences
    const minLength = Math.min(origWords.length, corrWords.length);
    for (let i = 0; i < minLength; i++) {
      const origWord = origWords[i].toLowerCase().replace(/[.,!?;:'"]/g, '');
      const corrWord = corrWords[i].toLowerCase().replace(/[.,!?;:'"]/g, '');
      if (origWord !== corrWord) {
        // Check if it's a minor variation (capitalization, punctuation)
        if (origWord.includes(corrWord) || corrWord.includes(origWord)) {
          // Minor change, don't count as substitution
          continue;
        }
        substitutions++;
      }
    }

    // Count additions and deletions
    if (corrWords.length > origWords.length) {
      additions = corrWords.length - origWords.length;
    } else {
      deletions = origWords.length - corrWords.length;
    }

    // Calculate total change score
    const totalChanges = substitutions + additions + deletions;
    const changeRatio = totalChanges / Math.max(origWords.length, corrWords.length);

    // UPDATED: More lenient thresholds
    // Reject only if more than 50% of words were changed (was 30%)
    // This allows legitimate grammar fixes while blocking complete rewrites
    if (changeRatio > 0.5) {
      console.warn(`[GrammarCorrector] Rejected - ${(changeRatio * 100).toFixed(1)}% of words changed (${substitutions} substitutions, ${additions} additions, ${deletions} deletions)`);
      return original;
    }

    // Validation passed - accept the corrections
    if (substitutions > 0 || additions > 0 || deletions > 0) {
      console.log(`[GrammarCorrector] ✅ Accepted - ${substitutions} substitutions, ${additions} additions, ${deletions} deletions (${(changeRatio * 100).toFixed(1)}% change)`);
    }
    return corrected;
  }

  /**
   * Correct grammar in text using the model
   * @param {string} text - Text to correct
   * @param {string} language - Language code (mostly for future use)
   * @returns {Promise<Object>} { corrected: string, matches: number }
   */
  async correct(text, language = null) {
    if (!this.enabled || !text || text.trim().length === 0) {
      return {
        corrected: text || '',
        matches: 0
      };
    }

    try {
      // Lazy initialization (non-blocking)
      if (!this.pipeline && !this.initializing) {
        // Start initialization but don't wait for it
        console.log('[GrammarCorrector] 🚀 Model not initialized, starting background initialization...');
        this.init().catch(err => {
          console.warn('[GrammarCorrector] Background init failed:', err.message);
        });
      }
      
      // If pipeline has the bug, switch to direct loading
      if (this._pipelineHasBug && !this._switchingToDirect) {
        this._switchingToDirect = true;
        console.log('[GrammarCorrector] 🔄 Pipeline has bug, switching to direct model loading...');
        // Trigger re-initialization with direct loading
        this.pipeline = null;
        this.status = 'loading';
        this.init().catch(err => {
          console.warn('[GrammarCorrector] Direct loading init failed:', err.message);
        });
      }
      
      // If model isn't ready, return original text immediately - don't wait
      if (!this.pipeline || this.initializing) {
        // Log status periodically (every 5 seconds) to show progress
        if (this.status === 'downloading' || this.status === 'loading') {
          const elapsed = this.initStartTime ? Math.floor((Date.now() - this.initStartTime) / 1000) : 0;
          if (!this._lastStatusLog || Date.now() - this._lastStatusLog > 5000) {
            console.log(`[GrammarCorrector] ⏳ Status: ${this.status.toUpperCase()} (${elapsed}s elapsed) - Using original text until ready`);
            this._lastStatusLog = Date.now();
          }
        } else if (this.status === 'not_initialized') {
          if (!this._lastStatusLog || Date.now() - this._lastStatusLog > 5000) {
            console.log('[GrammarCorrector] ⏳ Status: NOT_INITIALIZED - Initialization starting...');
            this._lastStatusLog = Date.now();
          }
        }
        // Model not ready - return original text without blocking
        return {
          corrected: text,
          matches: 0
        };
      }

      const original = text.trim();
      let corrected = original;
      
      if (this.useAPI) {
        // Use HuggingFace Inference API
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        
        try {
          const response = await fetch(this.apiUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(this.hfToken && { 'Authorization': `Bearer ${this.hfToken}` })
            },
            body: JSON.stringify({ inputs: original }),
            signal: controller.signal
          }).finally(() => clearTimeout(timeout));
          
          if (!response.ok) {
            if (response.status === 503) {
              console.warn('[GrammarCorrector] ⚠️ Model loading, using original text');
              return {
                corrected: original,
                matches: 0
              };
            } else {
              throw new Error(`API error: ${response.statusText}`);
            }
          }
          
          const result = await response.json();
          
          // API returns: [{ generated_text: "..." }] or string
          if (Array.isArray(result) && result.length > 0) {
            const firstResult = result[0];
            if (typeof firstResult === 'string') {
              corrected = firstResult;
            } else if (firstResult && typeof firstResult === 'object') {
              corrected = firstResult.generated_text || firstResult.text || original;
            }
          } else if (typeof result === 'string') {
            corrected = result;
          } else if (result && typeof result === 'object') {
            corrected = result.generated_text || result.text || result[0]?.generated_text || original;
          }
          
          // Log successful API correction (first time only to show it's working)
          if (corrected !== original && !this._apiWorkingLogged) {
            console.log('[GrammarCorrector] ✅ Grammar correction via API is working');
            this._apiWorkingLogged = true;
          }
        } catch (apiError) {
          console.warn('[GrammarCorrector] API request failed:', apiError.message);
          // Fallback to original text
          corrected = original;
        }
      } else {
        // Use local pipeline
        // Generate corrected text
        // The model takes potentially grammatically incorrect text
        // and outputs the corrected version
        let result;
        try {
          // NOTE: This T5 model is NOT instruction-tuned, so we pass raw text only
          // Instructions would confuse it and cause word additions
          // Instead, we rely on:
          // 1. Conservative decoding parameters (temperature, top_p, top_k)
          // 2. Length constraints (max_new_tokens based on input length)
          // 3. Post-processing validation (semantic similarity, word count)

          // UPDATED: Constrain model to minimal changes
          // Calculate max tokens based on input length
          // IMPORTANT: Add buffer for punctuation tokens (they're separate tokens)
          const inputWords = original.split(/\s+/).length;
          const maxTokens = Math.ceil(inputWords * 1.3 + 10); // 30% buffer + 10 for punctuation

          // UPDATED: VERY conservative parameters to prevent semantic drift
          // BUT allow proper punctuation handling
          result = await this.pipeline(original, {
            max_new_tokens: Math.min(maxTokens, 256), // Generous limit for punctuation
            num_beams: 1, // Single beam - most conservative (no alternatives)
            temperature: 0.01, // Near-zero for deterministic output
            top_p: 0.85, // Narrower nucleus - fewer token choices
            top_k: 10, // VERY small pool - extremely conservative (was 20)
            length_penalty: 1.0, // CHANGED: Neutral - don't force exact length (was 2.5)
            repetition_penalty: 1.0, // Neutral - don't affect grammar corrections
            do_sample: false, // Greedy decoding only
            early_stopping: false, // CHANGED: Don't stop early - let it finish punctuation (was true)
          });
        } catch (pipelineCallError) {
          // Log FULL error details before handling
          console.error('[GrammarCorrector] ===== PIPELINE CALL ERROR DETAILS =====');
          console.error('[GrammarCorrector] Error message:', pipelineCallError.message);
          console.error('[GrammarCorrector] Error name:', pipelineCallError.name);
          console.error('[GrammarCorrector] Error stack:', pipelineCallError.stack);
          if (pipelineCallError.cause) {
            console.error('[GrammarCorrector] Error cause:', pipelineCallError.cause);
          }
          try {
            console.error('[GrammarCorrector] Full error object:', JSON.stringify(pipelineCallError, Object.getOwnPropertyNames(pipelineCallError)));
          } catch (e) {
            console.error('[GrammarCorrector] Could not stringify error:', e.message);
          }
          console.error('[GrammarCorrector] ============================================');
          
          // Catch errors from the pipeline call (e.g., 'subarray' errors from @xenova/transformers)
          if (pipelineCallError.message && pipelineCallError.message.includes('subarray')) {
            console.warn('[GrammarCorrector] Pipeline internal error (subarray issue), falling back to original text');
            // Fall back to original text
            return {
              corrected: original,
              matches: 0
            };
          }
          // Re-throw other errors
          throw pipelineCallError;
        }

        // Extract corrected text from result
        // Result format from @xenova/transformers: [{ generated_text: "..." }]
        if (Array.isArray(result)) {
          if (result.length > 0) {
            // Handle array of results
            const firstResult = result[0];
            if (typeof firstResult === 'string') {
              corrected = firstResult;
            } else if (firstResult && typeof firstResult === 'object') {
              corrected = firstResult.generated_text || firstResult.text || original;
            }
          }
        } else if (typeof result === 'string') {
          corrected = result;
        } else if (result && typeof result === 'object') {
          // Handle object result
          corrected = result.generated_text || result.text || result.output || original;
        }

        // No need to extract from instruction prompt - we're passing raw text now
        // The model outputs the corrected text directly

        // Log successful local correction (first time only to show it's working)
        if (corrected !== original && !this._localWorkingLogged) {
          console.log('[GrammarCorrector] ✅ Grammar correction via local model is working');
          this._localWorkingLogged = true;
        }
      }

      // ADDED: Validate corrections before accepting them
      // This prevents the model from rewriting too much
      corrected = this.applyMinimalCorrection(original, corrected);

      // Ensure we have valid text
      if (!corrected || corrected.trim().length === 0) {
        corrected = original;
      }

      // Count approximate changes (simple heuristic)
      const matches = corrected.toLowerCase() !== original.toLowerCase() ? 1 : 0;

      return {
        corrected: corrected.trim(),
        matches
      };
    } catch (error) {
      // Don't log errors for every failed correction - only critical ones
      if (!error.message.includes('timeout') && !error.message.includes('not available')) {
        console.warn('[GrammarCorrector] Error correcting text:', error.message);
      }
      // Always fallback to original text on error - never block the flow
      return {
        corrected: text,
        matches: 0
      };
    }
  }

  /**
   * Check text for issues (placeholder for now)
   * @param {string} text - Text to check
   * @returns {Promise<Array>} List of detected issues
   */
  async check(text) {
    // Simple implementation - compare original vs corrected
    const result = await this.correct(text);
    const issues = [];
    
    if (result.matches > 0 && result.corrected !== text) {
      issues.push({
        original: text,
        corrected: result.corrected,
        confidence: 'medium'
      });
    }
    
    return issues;
  }

  /**
   * Clean up resources
   */
  dispose() {
    this.pipeline = null;
    this.enabled = false;
  }
}

// Singleton instance
let correctorInstance = null;

export function getGrammarCorrectorModel() {
  if (!correctorInstance) {
    correctorInstance = new GrammarCorrectorModel();
  }
  return correctorInstance;
}

export default GrammarCorrectorModel;

