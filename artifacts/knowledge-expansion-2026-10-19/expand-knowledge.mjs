// One-time, idempotent content maintenance record. Sources were read on 2026-10-19.
import { readFileSync, writeFileSync } from 'node:fs';
const read = name => JSON.parse(readFileSync(`knowledge/${name}.json`, 'utf8'));
const basic = read('basic-circuits');
const advanced = read('advanced-circuits');
const web = read('public-web-sources');
const date = '2026-10-19';
const refs = {
  i2c: ['TI SLVA689A — I2C Bus Pullup Resistor Calculation', 'https://www.ti.com/lit/an/slva689/slva689.pdf', '2–5'],
  cmos: ['TI SCBA004E — Implications of Slow or Floating CMOS Inputs', 'https://www.ti.com/lit/pdf/scba004', '2–7'],
  timer: ['TI xx555 Precision Timers — NE555 数据手册', 'https://www.ti.com/lit/ds/symlink/ne555.pdf', '无稳态应用与电气特性'],
  ldo: ['TI SLVA115A — ESR, Stability, and the LDO Regulator', 'https://www.ti.com/lit/an/slva115a/slva115a.pdf', '1–6'],
  reverse: ['TI SLVA139 — Reverse Current/Battery Protection Circuits', 'https://www.ti.com/lit/an/slva139/slva139.pdf', '1–2'],
  oring: ['TI LM66100 — Ideal Diode With Input Polarity Protection', 'https://www.ti.com/lit/ds/symlink/lm66100.pdf', '工作模式与应用章节'],
  thermal: ['TI SPRA953D — Semiconductor and IC Package Thermal Metrics', 'https://www.ti.com/lit/an/spra953d/spra953d.pdf', '1–10'],
  rs485: ['TI SLLA272D — The RS-485 Design Guide', 'https://www.ti.com/lit/an/slla272d/slla272d.pdf', '1–7'],
  comparator: ['TI TIDU020A — Comparator with Hysteresis Reference Design', 'https://www.ti.com/lit/ug/tidu020a/tidu020a.pdf', '4–10'],
  sampling: ['Analog Devices MT-002 — What the Nyquist Criterion Means to Your Sampled Data System Design', 'https://www.analog.com/media/en/training-seminars/tutorials/MT-002.pdf', '1–8'],
  quant: ['Analog Devices MT-001 — SNR = 6.02N + 1.76dB', 'https://www.analog.com/media/en/training-seminars/tutorials/MT-001.pdf', '1–4'],
  current: ['TI INAx180 — Low- and High-Side Current-Sense Amplifiers', 'https://www.ti.com/lit/ds/symlink/ina180.pdf', '应用与 Layout Guidelines'],
  pdn: ['TI SWPA222A — Power Delivery Network Analysis', 'https://www.ti.com/lit/pdf/swpa222', '8–13'],
  usbc: ['TI TUSB321 — USB Type-C Configuration Channel Logic and Port Control', 'https://www.ti.com/lit/ds/symlink/tusb321.pdf', 'CC 电气特性与 UFP 模式'],
  pwm: ['TI SBOA160D — In-Line Motor Current Measurements With PWM Rejection', 'https://www.ti.com/lit/an/sboa160/sboa160.pdf', '1–2'],
  buck: ["TI SLVA477 — Basic Calculation of a Buck Converter's Power Stage", 'https://www.ti.com/lit/an/slva477b/slva477b.pdf', '1–5；旧版本 URL 当前返回 Rev. C'],
  boost: ["TI SLVA372D — Basic Calculation of a Boost Converter's Power Stage", 'https://www.ti.com/lit/an/slva372d/slva372d.pdf', '1–7'],
  mcu: ['ST AN2586 — Getting started with STM32F10xxx hardware development', 'https://www.st.com/resource/en/application_note/cd00164185-getting-started-with-stm32f10xxx-hardware-development-stmicroelectronics.pdf', '电源、复位、启动及调试章节'],
};
const cite = key => ({ title: refs[key][0], url: refs[key][1], section: refs[key][2] });
const audit = (row, key) => Object.assign(row, {
  source: cite(key), verified: true, verifiedAt: date, authorityTier: 'A+',
  verificationScope: '已核对官方资料与本条适用条件；不是具体电路的仿真或硬件验证。',
});
const corrections = [];
function fix(id, key, changes, reason) {
  const row = [...basic, ...advanced].find(e => e.id === id);
  if (!row) throw new Error(id);
  Object.assign(row, changes);
  if (key) audit(row, key);
  corrections.push({ id, reason });
  return row;
}
fix('expert-decoupling-network', 'pdn', {
  summary: 'PDN 目标阻抗 Ztarget=ΔVallow/ΔIstep，单位为 Ω；允许电压波动除以负载电流变化，不能写反。',
  content: '例：允许波动 30 mV、负载阶跃 1.5 A，目标阻抗为 20 mΩ。ΔV 必须先扣除直流误差等预算；电流幅值定义须一致，不能把特定应用报告的 0.5 系数当成通式。电容有效容值、ESR、ESL、安装回路和反谐振共同决定有效频带，应进行阻抗扫描与负载阶跃验证，不能只靠固定电容组合。',
}, '修正目标阻抗倒数错误，补充量纲、算例和频带限制。');
advanced.find(e => e.id === 'expert-decoupling-network').rules.requiredChecks[0] = '按 Ztarget=ΔVallow/ΔIstep 计算目标阻抗，并校核目标频带内的阻抗峰与负载阶跃';
fix('expert-ldo-stability-thermal', 'ldo', {
  content: '稳定性按目标 LDO 的有效输出容值和 ESR 窗口检查；陶瓷兼容器件不能照搬老式 LDO 的最小 ESR 要求。损耗初估 Pd≈(Vin−Vout)Iout+Vin×Iq，结温估算必须采用适合实际板和气流的热参数；低输入角核对 dropout，高输入满载角核对热和瞬态。',
}, '移除运放手册误引，改为 LDO 稳定性原始资料并限定热估算。');
advanced.find(e => e.id === 'expert-ldo-stability-thermal').additionalSources = [cite('thermal')];
fix('expert-reverse-polarity', 'reverse', {
  content: '串联二极管的损耗约为 I×VF，MOSFET 导通损耗约为 I²RDS(on)，后者还需限制 VGS。单管防反接不等于能阻断输出向输入倒灌：导通沟道可双向传导，体二极管方向也必须核对。需要防倒灌时选有反向检测关断的器件；需要双向关断隔离时核对背靠背 MOSFET 结构与控制条件。',
}, 'TVS 文章不能支撑防反接拓扑；区分防反接、防倒灌和双向隔离。');
advanced.find(e => e.id === 'expert-reverse-polarity').additionalSources = [cite('oring')];
fix('expert-555-precision', 'timer', {
  summary: '555 频率误差由器件阈值、R/C 容差、漏电与温度共同决定，没有适用于所有 555 的“典型 ±5% 以上”结论。',
  content: '标准两电阻无稳态接法近似 f=1/[ln(2)(RA+2RB)C]、Dhigh=(RA+RB)/(RA+2RB)，正电阻条件下高电平占空比大于 50%。≤50% 需改变拓扑，例如另设充放电路径或采用数字时钟；改动后必须重算，不能继续套标准式。电阻上下限、输出能力和供电范围按具体双极型/CMOS 型号检查。',
}, '撤销无依据的通用精度数值，明确标准拓扑的占空比约束。');
fix('expert-pwm-frequency-choice', 'pwm', {
  summary: 'PWM 频率在电流纹波、开关损耗、定时分辨率和声学噪声之间折中；16 kHz 仍可能处于可听范围，不能把 16–20 kHz 宣称为避开可听域。',
  content: '电机常把高于约 20 kHz 作为减小基波可听噪声的起点，但机械共振、次谐波与调制仍需实测。开关频率升高增加单位时间切换次数及损耗，不必然使单个边沿的 dv/dt、di/dt 变大。还应检查最小脉宽、死区、电流采样建立时间和驱动器额定工作频率。',
}, '修正可听频段与开关频率/边沿速度混淆。');
fix('expert-mcu-power-domain', 'mcu', {
  content: '每个电源域的电容、VDDA/VREF 连接和时序按目标 MCU 手册确定；100 nF 加储能电容仅是常见起点。未用数字输入不能默认悬空，应按手册配置模拟模式、内部上/下拉或明确电平；输出、NC、保留脚、启动和调试脚分别处理。外设有电而 MCU 断电时核对引脚注入电流及倒灌。',
}, '去掉“未用引脚多数悬空”的误导；具体 MCU 电源连接仍由型号手册决定。');
advanced.find(e => e.id === 'expert-mcu-power-domain').sourceScope = 'AN2586 是 STM32F10xxx 系列示例；电源连接、电容和启动配置不能推广到其他 MCU。';
advanced.find(e => e.id === 'expert-mcu-power-domain').additionalSources = [cite('cmos')];
fix('expert-opamp-single-supply', null, {
  content: '单电源信号需落在器件输入共模和输出线性范围内；交流耦合时必须有直流偏置回路。超出共模范围可能导致失真、饱和或某些型号的相位反转，不能断言多数运放都会翻转。还应核对绝对最大值与钳位电流。轨到轨输入和轨到轨输出是不同指标；比较器与运放不可仅凭符号互换。',
}, '撤销“多数运放输出翻转”的无依据泛化。');
fix('adv-first-order', null, {
  content: '在电容电流、电感电压有限且不含理想冲激的条件下，电容电压与电感电流连续。孤立理想储能元件被理想源强制跃变时，可能需要冲激或得到不适定模型。从储能端口求 Req 时置零独立源、保留受控源；τ 公式只适用于可化为单一储能自由度的一阶网络。',
}, '补充状态连续性的有限激励前提。');
fix('adv-thevenin-norton', null, {
  summary: '具有适定线性端口关系的双端网络可按条件使用戴维南或诺顿等效；交流稳态使用阻抗，而非一律使用电阻。',
  content: '置零独立源、保留受控源，必要时施加测试源求端口阻抗。理想电压源的零内阻、理想电流源的无限内阻等退化情形不能直接作有限数值的源变换；含受控源还可能出现负等效电阻。',
}, '避免把所有线性网络无条件同时等效为两个有限内阻模型。');
fix('expert-li-ion-battery-safety', null, {
  summary: '锂电系统应按电芯化学体系和串数配置充电管理与过压、欠压、过流、短路、温度保护；多串组另评估均衡，单串没有串间均衡问题。',
  content: '保护器/BMS 不自动等于充电器，也不保证所有保护由同一芯片提供。充电截止、温度窗口和保护阈值来自电芯规格；多串均衡、独立二次保护与机械防护按系统风险和适用要求确定。自动草案未实现这些功能时应明确列为未覆盖。',
  verified: false,
}, '区分充电器、保护和均衡职责；未绑定电芯及规范的策略不标作已验证技术证据。');
advanced.find(e => e.id === 'expert-li-ion-battery-safety').rules.requiredChecks[0] = '核对充电管理及过充/过放/过流/短路/温度保护；多串电池另核对均衡需求';
fix('power-buck', 'buck', {}, '将泛化拓扑链接换为直接支撑 Buck 功率级公式的应用报告。');
fix('power-boost', 'boost', {
  summary: '普通 Boost 在理想连续导通稳态下 D≈1−Vin/Vout；输入最低电压通常对应较大输入与开关电流。',
  content: '先由能量预算算 Iin≈Vout×Iout/(ηVin)，再核算纹波峰值和额定值。连续导通模式的环路还受右半平面零点限制；断续或跳脉冲模式不能直接套用相同小信号模型。普通 Boost 关断时通常仍存在 VIN 到 VOUT 的路径。',
}, '更换直接来源，补充连续导通适用条件和关断直通。');
fix('power-ldo', 'ldo', {
  summary: 'LDO 可用于线性稳压，噪声与 PSRR 必须逐型号核对；功耗近似 (Vin−Vout)Iout+Vin×Iq。',
  content: '校核 dropout、有效输出容值及 ESR 稳定窗口。热阻与板面积、铜层和气流有关，手册 θJA 不能当作封装恒定属性；温升计算和实测均需覆盖高输入满载角。',
}, '补充来源，避免将所有 LDO 一概称为低噪声。');
basic.find(e => e.id === 'power-ldo').additionalSources = [cite('thermal')];
fix('timer-555', 'timer', {}, '为基础 555 公式补充可追溯数据手册。');
fix('fund-pullup-pulldown', 'cmos', {}, '为上拉下拉与默认电平规则补充官方原始资料。');
fix('fund-reset-monitor', null, {
  content: '复位极性、上拉和滤波按手册设置；BOR 阈值需覆盖所选时钟频率下的最低工作电压、Flash 写入和外设电压要求，不能只看 RAM 保持电压。危险输出应由硬件确保默认关断，极性决定用上拉还是下拉；慢上电、短时掉电和调试复位都要验证。',
}, '欠压复位不能只以 RAM 保持电压作为门槛。');

const additions = [];
function add(level, id, title, category, tags, summary, content, ref, checks = [], appliesTo = []) {
  const row = audit({ id, title, category, level, tags, summary, content }, ref);
  if (checks.length) row.rules = { appliesTo, requiredChecks: checks, verification: ['按目标器件与实际工况复核上述检查，并记录仿真或测量证据。'] };
  const target = level === '基础' ? basic : advanced;
  const index = target.findIndex(e => e.id === id);
  if (index < 0) target.push(row); else target[index] = row;
  additions.push(row);
  return row;
}
add('基础', 'fund-i2c-pullup-window', 'I²C 上拉电阻的上下限', '数字接口', ['i2c', 'i²c', '上拉', 'sda', 'scl', '总线电容'],
  '开漏 I²C 上拉同时受灌电流和上升时间限制；Rp(min)=(VDD−VOL(max))/IOL，Rp(max)=tr(max)/(0.8473Cb)。',
  '0.8473 对应 30%–70% 上升时间。例：3.3 V、VOL=0.4 V、IOL=3 mA、Cb=200 pF、tr=300 ns，标称窗口约 967 Ω–1.77 kΩ。合并各模块并联上拉后再检查阻值容差、供电角和芯片灌电流，不能固定使用 4.7 kΩ。', 'i2c');
add('基础', 'fund-logic-level-compatibility', '数字逻辑电平兼容与悬空输入', '数字接口', ['逻辑电平', 'cmos', '悬空', 'vih', 'vil', '上拉'],
  '数字电平兼容需满足 VOH(min)≥VIH(min)、VOL(max)≤VIL(max)，并核对电压、驱动电流和输入边沿限制。',
  '3.3 V 与 5 V 的名称不能决定兼容性；过压耐受与输入门限是两项条件。浮空或过慢边沿可导致不确定翻转和额外供电电流；用合适上/下拉或施密特输入处理，未用输出不可直接短接到电源或地。', 'cmos');
add('基础', 'fund-comparator-hysteresis', '比较器迟滞与开漏输出', '模拟', ['比较器', '迟滞', 'hysteresis', '开漏', '阈值'],
  '正反馈为比较器建立上、下两个阈值，以减小慢变输入附近的噪声抖动；开漏输出需要上拉。',
  '门限须用实际 VOH/VOL 和源阻抗计算；开漏上拉与反馈电阻相互加载，不能把输出高电平无条件当成电源电压。迟滞不能替代共模范围、失调、传播延迟及上电行为检查。', 'comparator');
add('基础', 'fund-adc-quantization', 'ADC 码宽、分辨率与准确度', '混合信号', ['adc', 'lsb', '量化', '分辨率', '精度'],
  '理想 N 位 ADC 的码宽 q=输入满量程跨度/2^N；分辨率不等于整体测量准确度。',
  '例：0–3.3 V 的 12 位理想 ADC，1 LSB≈0.806 mV。实际还包含参考误差、偏移、增益误差、INL 和噪声。满量程跨度与单端/差分编码须查手册；不得把 2^N−1 的显示端点缩放当作量化码宽定义。', 'quant');
add('基础', 'fund-sampling-aliasing', '采样、混叠与抗混叠滤波', '混合信号', ['adc', '采样', '混叠', '奈奎斯特', '抗混叠'],
  '对基带限带信号，无混叠采样要求 fs>2B；实际还需为模拟滤波器过渡带和带外干扰留空间。',
  '已经折叠入目标频带的混叠无法靠采样后数字低通消除。例：fs=10 kS/s 时 9 kHz 干扰可折叠到 1 kHz。带通欠采样须另验证频谱不重叠、模拟输入带宽和时钟质量，不能简单套基带规则。', 'sampling');
add('基础', 'fund-shunt-kelvin', '分流电阻测流与 Kelvin 取样', '测量', ['电流检测', '分流电阻', 'shunt', 'kelvin', '采样电阻'],
  '分流测量 Vshunt=IRshunt，电阻损耗 P=I²R；取样线应从电阻有效端点独立引出。',
  '例：5 A 经 10 mΩ 分流器产生 50 mV、0.25 W。选择功率时还需温度降额与脉冲能力；共用功率铜线的压降会被误测成电流。高边测量必须满足放大器输入共模范围，毫伏差分电压不代表共模电压低。', 'current');
add('基础', 'fund-rs485-termination', 'RS-485 总线终端与参考电位', '数字接口', ['rs485', 'rs-485', '终端电阻', '差分', '总线'],
  'RS-485 常以双绞线干线连接节点，在干线两端按电缆特性阻抗终端；常见值为 120 Ω。',
  '不应在每个节点都加 120 Ω；应缩短支线并按边沿和传播延时校核反射。差分传输仍有接收器共模范围，地电位差超限需合适隔离或参考连接；A/B 标注跨厂商可能不一致，要按真值表核对。', 'rs485');
add('基础', 'fund-usbc-cc-power', 'USB-C 取电的 CC 检测与电流边界', '数字接口', ['usb-c', 'type-c', 'cc1', 'cc2', '取电', 'pd'],
  'USB-C 受电端要有正确 CC 终端与连接检测；连接器外形不保证任意电压或任意电流。',
  '以受电插座为例，CC1、CC2 分别提供 Rd（常见标称 5.1 kΩ），或使用集成 Rd 的 CC 控制器，不能把两脚短接共用一个电阻。电流不得超过源端公布能力；高于默认 5 V 的供电需对应协议协商，单靠 Rd 不能得到 9 V/12 V。集成控制器按其手册连接，避免重复加 Rd。', 'usbc');

add('进阶', 'adv-i2c-capacitance-budget', 'I²C 总线电容与无解上拉窗口', '数字接口', ['i2c', '总线电容', '上升时间', '上拉', '时序'],
  '上拉窗口不存在时，继续减小电阻会超出器件灌电流能力；应减小电容、降低速率或按条件增加缓冲器。',
  'Cb 包含芯片引脚、连接器、线缆、保护器件及测量探头。多板并联上拉还会使等效阻值下降；每侧有电平转换或缓冲器时，应按器件模型分别核对。边沿达标并不自动保证时钟低电平宽度、建立/保持时间达标。', 'i2c', ['按最坏总线电容、上拉并联值和 VOL/IOL 检查上下限；若无交集，修改接口条件'], ['mcu-power']);
add('进阶', 'adv-rs485-failsafe', 'RS-485 空闲失效安全与总线负载', '数字接口', ['rs485', 'rs-485', '空闲', 'failsafe', '偏置', '终端'],
  '总线空闲、短路、开路是否输出确定电平取决于接收器失效安全设计；需要外部偏置时同时计算终端负载。',
  '两端 120 Ω 对直流呈约 60 Ω 差分负载。外加偏置须与接收器门限、噪声裕量和驱动器负载能力协调，不能在每节点重复偏置。单元负载数量、线长和数据率是不同约束；普通 RS-485 共模范围也不是任意地电位差。', 'rs485');
add('进阶', 'adv-comparator-threshold-budget', '比较器迟滞门限的节点方程', '模拟', ['比较器', '迟滞', '阈值', '正反馈', '节点方程'],
  '反相比较器若 V+ 经 Rref 接理想 Vref、经 Rfb 接输出，则门限 Vth=(Vref/Rref+Vout/Rfb)/(1/Rref+1/Rfb)。',
  '输入接 V−，分别代入 VOH、VOL 得上下阈值。例：Vref=1.65 V、Rref=10 kΩ、Rfb=100 kΩ、VOH=3.3 V、VOL=0，阈值为 1.8 V 与 1.5 V。此例按理想推挽输出；开漏必须连同上拉解节点，实际再加偏置电流、失调和电阻容差。', 'comparator');
add('进阶', 'adv-adc-noise-oversampling', 'ADC 量化噪声与过采样增益', '混合信号', ['adc', 'snr', '过采样', '量化噪声', 'enob'],
  '理想满幅正弦、量化误差近似不相关时，全奈奎斯特带内 SNR≈6.02N+1.76 dB；不代表实际 ADC 准确度。',
  '带宽缩小后的处理增益约为 10log10(fs/(2B)) dB。约四倍过采样配合适当低通和抽取可改善约 6 dB，但前提是相关噪声模型成立；重复同一码、参考漂移、INL 和混叠不会因此自动消失。', 'quant');
add('进阶', 'adv-antialias-filter-budget', '抗混叠滤波器的阻带预算', '混合信号', ['抗混叠', '滤波', 'adc', '阻带', '采样率'],
  '先列出会折叠入目标频带的干扰，再确定模拟滤波器在对应频率需要的衰减；不能只指定 fc=fs/2。',
  '若某带外干扰幅值 1 V、允许折叠后残留 1 mV，需要至少 60 dB 衰减。模拟滤波器还须兼顾通带误差、过渡带、驱动稳定性和采集建立时间；这些条件决定一阶 RC 是否足够。', 'sampling', ['按带外干扰幅值和允许残留计算阻带衰减，并验证采样建立时间'], ['rc-filter']);
add('进阶', 'adv-shunt-error-budget', '电流检测的失调、热漂移与布线误差', '测量', ['电流检测', '分流电阻', '失调', 'kelvin', '共模', '误差预算'],
  '分流测量低电流误差常由输入失调主导：等效电流误差约 Vos/Rshunt；大电流时须计入电阻自热和增益误差。',
  '例：100 µV 输入失调、10 mΩ 分流器对应约 10 mA 电流偏差。加上分流器容差/TCR、放大器增益误差、ADC/参考误差；PWM 共模阶跃还会造成动态误差。不能只检查静态共模范围就判定瞬态采样准确。', 'current', ['测流链按最小电流的失调和最大电流的自热分别核算；Kelvin 取样并检查共模瞬态'], ['motor-driver', 'low-side-driver']);
add('进阶', 'adv-thermal-metrics-boundary', 'θJA、θJC 与 ΨJT 的使用边界', '热设计', ['热阻', '结温', 'θja', 'θjc', 'ψjt', '散热'],
  'θJA 是给定板、气流与环境下的系统结果；不能把数据手册测试板的 θJA 当作任意 PCB 的固定热阻。',
  'Tj≈Ta+Pd×θJA 只在条件匹配时用于估算。ΨJT 是热表征参数，可结合壳顶温度及功耗估计结温，不能当作严格热阻与 θJC 任意串并联。具体封装的散热焊盘连接和绝缘要求必须查手册。', 'thermal', ['按实际 PCB、气流和环境解释热参数，结合损耗与测温验证结温'], ['ldo', 'buck', 'boost', 'motor-driver', 'low-side-driver']);
add('进阶', 'adv-power-oring-backfeed', '多电源 OR-ing 与断电倒灌', '电源', ['oring', '理想二极管', '倒灌', '多电源', '反向电流'],
  '多路电源并用需要核对反向电流阻断；理想二极管行为取决于比较器关断、体二极管与使能状态。',
  '分析输入掉电而输出由另一路保持的条件；不能把普通导通 MOSFET 当成单向器件。LM66100 是具体低压器件示例，不能把其限制推广到任意电源轨；高压、大电流、关断隔离或均流需求须重新选器件和拓扑。', 'oring', ['验证一路掉电而输出有电时的倒灌与切换瞬态；按需求区分 OR-ing 和双向关断'], ['mcu-power', 'ldo']);
add('进阶', 'adv-pdn-antiresonance', 'PDN 反谐振与电容安装电感', 'PCB', ['pdn', '反谐振', '去耦', 'esl', '目标阻抗'],
  '不同容值的电容并联不保证所有频率阻抗都下降；安装电感和 ESR 会形成或移动阻抗峰。',
  '用实际偏压下的电容模型与布局寄生评估目标频带，优先缩小电源-电容-地回路，再选择容值和阻尼。过多理想低 ESR 电容模型可能掩盖实际反谐振；通过阻抗扫描与负载阶跃交叉验证。', 'pdn');
add('进阶', 'adv-buck-ripple-budget', 'Buck CCM 纹波与峰值电流算例', '电源', ['buck', '降压', 'ccm', '纹波', '电感', '峰值电流'],
  '理想连续导通 Buck：D=Vout/Vin，ΔIL=(Vin−Vout)D/(Lfs)，ILpeak=Iout+ΔIL/2。',
  '12 V→5 V、1 A、22 µH、500 kHz 时，ΔIL≈0.265 A，峰值≈1.133 A。电容纹波初估 ΔVC≈ΔIL/(8fsC)，ESR 项≈ΔIL×ESR；瞬态、电容降容及实测尖峰需单独检查，公式不可直接外推到 DCM/跳脉冲。', 'buck');
add('进阶', 'adv-boost-current-budget', 'Boost 输出电流与输入峰值的区别', '电源', ['boost', '升压', '输入电流', '效率', '峰值电流'],
  'Boost 输入电流约 Iin=Vout×Iout/(ηVin)，电感平均电流约等于输入电流，不能用输出电流直接选电感或限流值。',
  '例：3.3 V→12 V、输出 0.3 A、假设效率 85%，平均输入电流约 1.283 A，峰值还需加纹波的一半。效率是假设，随输入、负载与温度变化；需在最低输入角核算，并核对启动、限流与输出短路路径。', 'boost');
add('进阶', 'adv-555-tolerance-budget', '555 标称频率与 R/C 容差范围', '时序', ['555', '容差', '频率', '占空比', '最坏工况'],
  '标准 555 无稳态 f 与 (RA+2RB)C 成反比；标称值对了不代表容差角达标。',
  '若两电阻各 ±1%、电容 ±5%，仅 R/C 造成的频率范围为标称的约 0.943–1.063 倍，尚未包含芯片阈值、漏电、温漂和供电影响。精密时基应按误差预算选晶振、MCU 定时器或专用器件。', 'timer', ['频率范围同时覆盖电阻、电容、芯片阈值与温度，区分标称计算和保证精度'], ['timer555']);

// Curated public summaries are distinct from source documents; never mirror their text.
const topics = {
  i2c: 'I²C 上拉与总线电容', cmos: 'CMOS 默认状态与电平边界', timer: '555 时序与容差',
  ldo: 'LDO 输出电容与稳定性', reverse: '电池反接与反向路径', oring: '电源 OR-ing 与防倒灌',
  thermal: '封装热参数的使用限制', rs485: 'RS-485 终端与失效安全', comparator: '比较器迟滞设计',
  sampling: '采样与抗混叠', quant: '量化与过采样', current: '分流测流与 Kelvin 布线',
  pdn: 'PDN 目标阻抗与反谐振', usbc: 'USB-C CC 连接检测', pwm: 'PWM 噪声与动态测流',
  buck: 'Buck 连续导通功率级', boost: 'Boost 功率级与输入电流',
  mcu: 'MCU 电源、复位与启动边界',
};
for (const [key, [title, url, section]] of Object.entries(refs)) {
  const matched = [...basic, ...advanced].filter(row => row.source?.url === url);
  const content = `# ${topics[key]}\n` + matched.map(row => `## ${row.title}\n${row.summary}\n${row.content}`).join('\n\n')
    + '\n\n适用边界：摘要为自撰学习说明及标称算例；器件额定值与引脚连接须按目标型号及版本核对，不能作为已完成的硬件验证。';
  const publisher = key === 'mcu' ? 'STMicroelectronics' : key === 'sampling' || key === 'quant' ? 'Analog Devices' : 'Texas Instruments';
  const record = { title, url, publisher, authors: publisher,
    accessedAt: date, rightsStatus: 'unknown', rightsNote: '官方公开资料的自撰归纳与自算示例；原文版权归权利人，不复制原图、正文或表格。',
    metadata: { kind: ['timer', 'oring', 'current', 'usbc'].includes(key) ? 'vendor-datasheet' : 'vendor-application-note',
      authorityTier: 'A+', topic: topics[key], section,
      comparison: '此来源支撑所述原理或对应器件示例；具体型号的工作范围和版本优先，不将通用知识或样例额定值推广到其他器件。',
      verifiedAt: date, verificationMethod: '人工打开官方页面/文档核对标题与相关章节；计算例为独立整理。' }, content };
  const index = web.findIndex(row => row.url === url);
  if (index < 0) web.push(record); else web[index] = record;
}
for (const [name, rows] of [['basic-circuits', basic], ['advanced-circuits', advanced], ['public-web-sources', web]]) {
  writeFileSync(`knowledge/${name}.json`, JSON.stringify(rows, null, 2) + '\n');
}
writeFileSync('artifacts/knowledge-expansion-2026-10-19/content-changes.json', JSON.stringify({ date, counts: { basic: basic.length, advanced: advanced.length, publicSources: web.length }, corrections, additions: additions.map(e => ({ id: e.id, title: e.title, source: e.source })) }, null, 2) + '\n');
console.log(JSON.stringify({ basic: basic.length, advanced: advanced.length, publicSources: web.length, corrected: corrections.length, added: additions.length }));
